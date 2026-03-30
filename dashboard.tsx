"use client";

/**
 * Dashboard.tsx — RWA Arbitrage Command Center
 * Next.js 14 | Dark Mode + Neon Accents + Glassmorphism
 *
 * ⚠️  PRIVATE_KEY jamais sai do browser. Apenas assina a tx localmente.
 */

import { useState, useCallback, useEffect, useRef } from "react";
import { ethers, Wallet, JsonRpcProvider, getAddress } from "ethers";

// ─── Types ────────────────────────────────────────────────────────────────────

type Phase = "idle" | "validating" | "quoting" | "signing" | "broadcasting" | "done" | "error";

interface ArbitrageResult {
  success: boolean;
  phase: string;
  estimatedProfit?: string;
  estimatedGasCost?: string;
  netProfit?: string;
  txHash?: string;
  bundleData?: object;
  error?: string;
  log: string[];
}

interface Config {
  walletAddress: string;
  privateKey: string;
  alchemyRpcUrl: string;
  flashLoanAmount: string;
  rwaToken: string;
}

// ─── Neon colour tokens ───────────────────────────────────────────────────────

const NEON = {
  cyan:   "#00FFE7",
  purple: "#B44FFF",
  green:  "#00FF85",
  red:    "#FF3D5A",
  gold:   "#FFD700",
};

// ─── Inline styles (no Tailwind dep needed) ───────────────────────────────────

const css = {
  root: {
    minHeight: "100vh",
    background: "radial-gradient(ellipse 80% 60% at 50% -10%, #0d1a2a 0%, #060b12 100%)",
    fontFamily: "'JetBrains Mono', 'Fira Code', 'Courier New', monospace",
    color: "#c9e8ff",
    padding: "0",
    margin: "0",
    overflow: "hidden",
  } as React.CSSProperties,

  grid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gridTemplateRows: "auto 1fr",
    gap: "20px",
    maxWidth: "1280px",
    margin: "0 auto",
    padding: "28px 24px",
    height: "100vh",
    boxSizing: "border-box",
  } as React.CSSProperties,

  glass: (accent = NEON.cyan) => ({
    background: "rgba(10, 20, 35, 0.72)",
    backdropFilter: "blur(18px)",
    border: `1px solid ${accent}22`,
    borderRadius: "14px",
    boxShadow: `0 0 32px ${accent}18, inset 0 1px 0 ${accent}14`,
  } as React.CSSProperties),

  header: {
    gridColumn: "1 / -1",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "18px 24px",
    background: "rgba(10, 20, 35, 0.72)",
    backdropFilter: "blur(18px)",
    border: `1px solid ${NEON.cyan}22`,
    borderRadius: "14px",
    boxShadow: `0 0 40px ${NEON.cyan}12`,
  } as React.CSSProperties,

  label: {
    display: "block",
    fontSize: "10px",
    letterSpacing: "2px",
    textTransform: "uppercase" as const,
    color: NEON.cyan,
    marginBottom: "6px",
    opacity: 0.75,
  },

  input: {
    width: "100%",
    background: "rgba(0,255,231,0.04)",
    border: `1px solid ${NEON.cyan}30`,
    borderRadius: "8px",
    padding: "10px 14px",
    color: "#e0f4ff",
    fontSize: "13px",
    fontFamily: "inherit",
    outline: "none",
    transition: "border-color 0.2s, box-shadow 0.2s",
    boxSizing: "border-box" as const,
  } as React.CSSProperties,

  btn: (color = NEON.cyan, disabled = false) => ({
    background: disabled
      ? "rgba(100,100,120,0.15)"
      : `linear-gradient(135deg, ${color}22 0%, ${color}08 100%)`,
    border: `1px solid ${disabled ? "#444" : color}`,
    borderRadius: "10px",
    color: disabled ? "#555" : color,
    cursor: disabled ? "not-allowed" : "pointer",
    fontFamily: "inherit",
    fontSize: "12px",
    fontWeight: 700,
    letterSpacing: "2px",
    padding: "12px 24px",
    textTransform: "uppercase" as const,
    transition: "all 0.2s",
    boxShadow: disabled ? "none" : `0 0 20px ${color}28`,
  } as React.CSSProperties),
};

// ─── Stat Card ────────────────────────────────────────────────────────────────

function StatCard({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <div style={{
      ...css.glass(accent),
      padding: "16px 20px",
      flex: 1,
      minWidth: 0,
    }}>
      <div style={{ fontSize: "10px", letterSpacing: "2px", color: accent, opacity: 0.7, marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ fontSize: "22px", fontWeight: 700, color: accent, textShadow: `0 0 12px ${accent}80` }}>
        {value}
      </div>
    </div>
  );
}

// ─── Log Terminal ─────────────────────────────────────────────────────────────

function Terminal({ logs }: { logs: string[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [logs]);

  const lineColor = (l: string) => {
    if (l.startsWith("✅")) return NEON.green;
    if (l.startsWith("❌") || l.startsWith("🚫")) return NEON.red;
    if (l.startsWith("🚀")) return NEON.purple;
    if (l.startsWith("📦") || l.startsWith("📊")) return NEON.gold;
    return "#7ab8d4";
  };

  return (
    <div ref={ref} style={{
      background: "rgba(0,0,0,0.55)",
      borderRadius: "10px",
      border: "1px solid #ffffff0a",
      padding: "14px 16px",
      height: "220px",
      overflowY: "auto",
      fontSize: "11.5px",
      lineHeight: "20px",
    }}>
      {logs.length === 0
        ? <span style={{ color: "#3a5a6a" }}>// awaiting execution...</span>
        : logs.map((l, i) => (
            <div key={i} style={{ color: lineColor(l) }}>
              <span style={{ color: "#2a4a5a", marginRight: 8 }}>{String(i).padStart(3, "0")}</span>
              {l}
            </div>
          ))
      }
    </div>
  );
}

// ─── Phase Badge ──────────────────────────────────────────────────────────────

function PhaseBadge({ phase }: { phase: Phase }) {
  const map: Record<Phase, [string, string]> = {
    idle:         ["◉ IDLE",        "#3a5a6a"],
    validating:   ["⟳ VALIDATING",  NEON.gold],
    quoting:      ["⟳ QUOTING",     NEON.cyan],
    signing:      ["⟳ SIGNING",     NEON.purple],
    broadcasting: ["⟳ BROADCAST",   NEON.purple],
    done:         ["✓ COMPLETE",    NEON.green],
    error:        ["✕ ERROR",       NEON.red],
  };
  const [label, color] = map[phase];
  const spinning = ["validating","quoting","signing","broadcasting"].includes(phase);

  return (
    <div style={{
      display: "inline-flex",
      alignItems: "center",
      gap: 8,
      fontSize: "11px",
      letterSpacing: "2px",
      color,
      padding: "5px 14px",
      border: `1px solid ${color}44`,
      borderRadius: "20px",
      background: `${color}10`,
    }}>
      <span style={{
        display: "inline-block",
        animation: spinning ? "spin 1s linear infinite" : "none",
      }}>
        {label.split(" ")[0]}
      </span>
      {label.split(" ")[1]}
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

// ─── Main Dashboard ───────────────────────────────────────────────────────────

export default function Dashboard() {
  const [config, setConfig] = useState<Config>({
    walletAddress: "",
    privateKey: "",
    alchemyRpcUrl: "",
    flashLoanAmount: "20000",
    rwaToken: "",
  });
  const [showKey, setShowKey] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [result, setResult] = useState<ArbitrageResult | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [dryRun, setDryRun] = useState(true);

  const addLog = (msg: string) => setLogs(p => [...p, msg]);

  // ── Auto-preencher wallet a partir da private key ──────────────────────────
  const handleKeyChange = (val: string) => {
    setConfig(p => ({ ...p, privateKey: val }));
    try {
      const wallet = new Wallet(val.trim());
      setConfig(p => ({ ...p, walletAddress: wallet.address, privateKey: val }));
      addLog(`🔑 Endereço derivado: ${wallet.address}`);
    } catch { /* chave inválida ainda sendo digitada */ }
  };

  // ── Execução principal ─────────────────────────────────────────────────────
  const execute = useCallback(async () => {
    setLogs([]);
    setResult(null);

    try {
      // ── Fase 1: validação local ──────────────────────────────────────────
      setPhase("validating");
      addLog("🔵 Iniciando validação local...");

      const addr = getAddress(config.walletAddress.trim());
      if (!config.alchemyRpcUrl.startsWith("https://")) throw new Error("RPC URL inválida");
      if (!config.rwaToken) throw new Error("Endereço do RWA Token obrigatório");
      addLog(`✅ Endereço validado: ${addr}`);

      // ── Fase 2: chamar Edge Function (quote + profit guard) ──────────────
      setPhase("quoting");
      addLog("📊 Consultando Edge Function para quote e profit check...");

      const quoteRes = await fetch("/api/execute-arbitrage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          walletAddress: addr,
          alchemyRpcUrl: config.alchemyRpcUrl,
          flashLoanAmount: config.flashLoanAmount,
          tokenIn: config.rwaToken,
          tokenOut: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
          dryRun,
        }),
      });

      const quoteData: ArbitrageResult = await quoteRes.json();
      quoteData.log?.forEach(addLog);

      setResult(quoteData);

      if (!quoteData.success || quoteData.error === "Insufficient Profit") {
        setPhase("error");
        return;
      }

      if (dryRun) {
        addLog("🔵 Dry Run concluído — sem envio de tx");
        setPhase("done");
        return;
      }

      // ── Fase 3: assinar localmente (PRIVATE_KEY nunca sai do browser) ────
      setPhase("signing");
      addLog("🔐 Assinando transação localmente (chave não sai do browser)...");

      const provider = new JsonRpcProvider(config.alchemyRpcUrl);
      const wallet   = new Wallet(config.privateKey.trim(), provider);

      // Construir tx de chamada para initiateFlashLoan()
      // ABI mínimo do contrato
      const CONTRACT_ADDRESS = "<DEPLOY_RWA_ARBITRAGE_CONTRACT_ADDRESS>";
      const iface = new ethers.Interface([
        "function initiateFlashLoan(uint256,address,bytes,bytes) external",
      ]);

      const bundle = quoteData.bundleData as {
        amounts: string[];
        userData: string;
      };

      const calldata = iface.encodeFunctionData("initiateFlashLoan", [
        BigInt(bundle?.amounts?.[0] ?? "20000000000"),
        config.rwaToken,
        "0x",   // swapDataIn vem do 1inch SDK — simplificado para demo
        "0x",
      ]);

      const nonce    = await provider.getTransactionCount(wallet.address, "latest");
      const feeData  = await provider.getFeeData();

      const txRequest = {
        to:                   CONTRACT_ADDRESS,
        data:                 calldata,
        nonce,
        maxFeePerGas:         feeData.maxFeePerGas ?? 50_000_000_000n,
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? 2_000_000_000n,
        gasLimit:             500_000n,
        chainId:              137,
        type:                 2,
      };

      const signedTx = await wallet.signTransaction(txRequest);
      addLog("✅ Transação assinada localmente");

      // ── Fase 4: broadcast via Edge Function + Private RPC ─────────────────
      setPhase("broadcasting");
      addLog("🚀 Enviando bundle via Private RPC (Flashbots/Alchemy)...");

      const broadcastRes = await fetch("/api/execute-arbitrage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          walletAddress: addr,
          alchemyRpcUrl: config.alchemyRpcUrl,
          flashLoanAmount: config.flashLoanAmount,
          tokenIn: config.rwaToken,
          tokenOut: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
          signedTx,
        }),
      });

      const broadcastData: ArbitrageResult = await broadcastRes.json();
      broadcastData.log?.forEach(addLog);
      setResult(prev => ({ ...prev!, ...broadcastData }));

      setPhase(broadcastData.success ? "done" : "error");

    } catch (err) {
      addLog(`❌ ERRO: ${(err as Error).message}`);
      setPhase("error");
      setResult(prev => ({ ...(prev ?? { success: false, log: [] }), error: (err as Error).message, success: false }));
    }
  }, [config, dryRun]);

  const busy = ["validating","quoting","signing","broadcasting"].includes(phase);

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div style={css.root}>
      {/* Ambient glow orbs */}
      <div style={{
        position: "fixed", top: "-200px", left: "-200px",
        width: 600, height: 600, borderRadius: "50%",
        background: `radial-gradient(circle, ${NEON.cyan}10 0%, transparent 70%)`,
        pointerEvents: "none", zIndex: 0,
      }} />
      <div style={{
        position: "fixed", bottom: "-200px", right: "-150px",
        width: 500, height: 500, borderRadius: "50%",
        background: `radial-gradient(circle, ${NEON.purple}12 0%, transparent 70%)`,
        pointerEvents: "none", zIndex: 0,
      }} />

      <div style={{ ...css.grid, position: "relative", zIndex: 1 }}>

        {/* ── Header ─────────────────────────────────────────────────────── */}
        <div style={css.header}>
          <div>
            <div style={{
              fontSize: "20px", fontWeight: 800, letterSpacing: "4px",
              color: NEON.cyan, textShadow: `0 0 24px ${NEON.cyan}`,
            }}>
              ◈ RWA ARBITRAGE
            </div>
            <div style={{ fontSize: "10px", letterSpacing: "3px", color: "#3a6a7a", marginTop: 2 }}>
              BALANCER V2 FLASH LOAN • 1INCH FUSION • POLYGON
            </div>
          </div>
          <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: "11px", color: "#5a8a9a", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={dryRun}
                onChange={e => setDryRun(e.target.checked)}
                style={{ accentColor: NEON.gold }}
              />
              DRY RUN
            </label>
            <PhaseBadge phase={phase} />
          </div>
        </div>

        {/* ── Left Column: Config ─────────────────────────────────────────── */}
        <div style={{ ...css.glass(), padding: "24px", display: "flex", flexDirection: "column", gap: 18 }}>
          <div style={{
            fontSize: "11px", letterSpacing: "3px", color: NEON.cyan,
            borderBottom: `1px solid ${NEON.cyan}20`, paddingBottom: 12, marginBottom: 4,
          }}>
            ◈ CONFIGURAÇÃO
          </div>

          {/* Wallet Address */}
          <div>
            <label style={css.label}>Wallet Address</label>
            <input
              style={css.input}
              placeholder="0x..."
              value={config.walletAddress}
              onChange={e => setConfig(p => ({ ...p, walletAddress: e.target.value }))}
            />
          </div>

          {/* Private Key */}
          <div>
            <label style={css.label}>Private Key <span style={{ color: NEON.red, fontSize: 9 }}>(armazenada apenas localmente)</span></label>
            <div style={{ position: "relative" }}>
              <input
                style={{ ...css.input, paddingRight: 44 }}
                type={showKey ? "text" : "password"}
                placeholder="0x..."
                value={config.privateKey}
                onChange={e => handleKeyChange(e.target.value)}
              />
              <button
                onClick={() => setShowKey(v => !v)}
                style={{
                  position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)",
                  background: "none", border: "none", color: NEON.cyan, cursor: "pointer",
                  fontSize: 14, padding: 2,
                }}
              >
                {showKey ? "🙈" : "👁"}
              </button>
            </div>
          </div>

          {/* Alchemy RPC */}
          <div>
            <label style={css.label}>Alchemy RPC URL</label>
            <input
              style={css.input}
              placeholder="https://polygon-mainnet.g.alchemy.com/v2/YOUR_KEY"
              value={config.alchemyRpcUrl}
              onChange={e => setConfig(p => ({ ...p, alchemyRpcUrl: e.target.value }))}
            />
          </div>

          {/* RWA Token */}
          <div>
            <label style={css.label}>RWA Token Address (Polygon)</label>
            <input
              style={css.input}
              placeholder="0x... (ex: ONDO, RIO, BACKED)"
              value={config.rwaToken}
              onChange={e => setConfig(p => ({ ...p, rwaToken: e.target.value }))}
            />
          </div>

          {/* Flash Loan Amount */}
          <div>
            <label style={css.label}>Flash Loan Amount (USDT)</label>
            <input
              style={css.input}
              type="number"
              min="1000"
              max="100000"
              value={config.flashLoanAmount}
              onChange={e => setConfig(p => ({ ...p, flashLoanAmount: e.target.value }))}
            />
          </div>

          {/* Execute Button */}
          <button
            onClick={execute}
            disabled={busy}
            style={{ ...css.btn(busy ? undefined : NEON.cyan, busy), marginTop: 4 }}
          >
            {busy ? "⟳ EXECUTANDO..." : "⚡ EXECUTAR ARBITRAGEM"}
          </button>
        </div>

        {/* ── Right Column: Results ───────────────────────────────────────── */}
        <div style={{ ...css.glass(NEON.purple), padding: "24px", display: "flex", flexDirection: "column", gap: 18 }}>
          <div style={{
            fontSize: "11px", letterSpacing: "3px", color: NEON.purple,
            borderBottom: `1px solid ${NEON.purple}20`, paddingBottom: 12, marginBottom: 4,
          }}>
            ◈ RESULTADOS
          </div>

          {/* Stat Cards */}
          <div style={{ display: "flex", gap: 12 }}>
            <StatCard label="Lucro Bruto" value={result?.estimatedProfit ? `$${result.estimatedProfit}` : "—"} accent={NEON.cyan} />
            <StatCard label="Custo Gás"   value={result?.estimatedGasCost  ? `$${result.estimatedGasCost}`  : "—"} accent={NEON.gold} />
            <StatCard label="Lucro Líq."  value={result?.netProfit         ? `$${result.netProfit}`         : "—"} accent={result?.netProfit && parseFloat(result.netProfit) > 0 ? NEON.green : NEON.red} />
          </div>

          {/* Tx Hash */}
          {result?.txHash && (
            <div style={{
              ...css.glass(NEON.green),
              padding: "12px 16px",
              fontSize: "11px",
              wordBreak: "break-all",
            }}>
              <span style={{ color: NEON.green, marginRight: 8 }}>✅ TX HASH:</span>
              <a
                href={`https://polygonscan.com/tx/${result.txHash}`}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: NEON.cyan, textDecoration: "none" }}
              >
                {result.txHash}
              </a>
            </div>
          )}

          {/* Error */}
          {result?.error && (
            <div style={{
              ...css.glass(NEON.red),
              padding: "12px 16px",
              fontSize: "11px",
              color: NEON.red,
            }}>
              ✕ {result.error}
            </div>
          )}

          {/* Terminal Log */}
          <div>
            <label style={{ ...css.label, color: NEON.purple }}>EXECUTION LOG</label>
            <Terminal logs={logs} />
          </div>

          {/* Clear */}
          <button
            onClick={() => { setLogs([]); setResult(null); setPhase("idle"); }}
            style={{ ...css.btn(NEON.red, false), alignSelf: "flex-end", padding: "8px 16px", fontSize: "10px" }}
          >
            LIMPAR
          </button>
        </div>

      </div>
    </div>
  );
}
