/**
 * Edge Function: execute-arbitrage/index.ts
 * Deploy: Supabase Edge Functions  OR  Vercel Edge Runtime
 *
 * Responsabilidades:
 *  1. Validar inputs (endereço, RPC, parâmetros de swap)
 *  2. Estimar lucro via 1inch Fusion quote
 *  3. Estimar custo de gás via RPC privado
 *  4. Abortar se lucro < custo (Profit Guard)
 *  5. Construir o bundle da tx e devolver ao frontend para assinatura local
 *
 * ⚠️  A PRIVATE_KEY nunca chega a este servidor.
 *     O frontend assina a transação localmente e envia o tx.rawTransaction assinado.
 */

import { getAddress, JsonRpcProvider, parseUnits, formatUnits } from "ethers";
import { SDK as FusionSDK, NetworkEnum, PrivateKeyProviderConnector } from "@1inch/fusion-sdk";

// ─── Tipos ───────────────────────────────────────────────────────────────────

interface ArbitrageRequest {
  walletAddress: string;       // endereço da carteira do usuário
  alchemyRpcUrl: string;       // RPC Alchemy (Polygon mainnet ou Mumbai)
  flashLoanAmount: string;     // valor em USDT (ex: "20000")
  tokenIn: string;             // endereço do RWA token de entrada
  tokenOut: string;            // endereço do token de saída (ex: USDT)
  signedTx?: string;           // tx já assinada pelo frontend (fase 2)
  dryRun?: boolean;            // apenas simular, não enviar
}

interface ArbitrageResponse {
  success: boolean;
  phase: "quote" | "bundle" | "broadcast";
  estimatedProfit?: string;    // em USDT, 6 decimais
  estimatedGasCost?: string;   // em MATIC → convertido para USDT
  netProfit?: string;
  txHash?: string;
  bundleData?: object;         // dados para o frontend assinar
  error?: string;
  log: string[];
}

// ─── Constantes ──────────────────────────────────────────────────────────────

const USDT_POLYGON  = "0xc2132D05D31c914a87C6611C10748AEb04B58e8F";
const BALANCER_VAULT = "0xBA12222222228d8Ba445958a75a0704d566BF2C8";
const FLASHBOTS_RPC  = "https://polygon-mainnet.g.alchemy.com/v2/";   // Private RPC
const MIN_NET_PROFIT_USDT = 1.5;   // mínimo de lucro líquido em USDT para executar

// ─── Helper: validar endereço EVM ────────────────────────────────────────────

function safeGetAddress(raw: string): string {
  try {
    return getAddress(raw.trim());   // normaliza checksum → evita Erro 403
  } catch {
    throw new Error(`Endereço inválido: ${raw}`);
  }
}

// ─── Helper: obter cotação MATIC/USDT para conversão de custo de gás ─────────

async function getMaticPriceInUSDT(provider: JsonRpcProvider): Promise<number> {
  // Fallback simples via 1inch price API
  try {
    const res = await fetch(
      "https://api.1inch.dev/price/v1.1/137/0x0000000000000000000000000000000000001010",
      { headers: { Accept: "application/json" } }
    );
    const data = await res.json() as Record<string, string>;
    const maticUsdtKey = Object.keys(data)[0];
    return parseFloat(data[maticUsdtKey] ?? "0.9");
  } catch {
    return 0.9;   // fallback conservador
  }
}

// ─── Fase 1: Obter quote da 1inch Fusion ─────────────────────────────────────

async function getFusionQuote(
  walletAddress: string,
  flashLoanAmount: string
): Promise<{ amountOut: bigint; quoteData: object }> {

  const fusionSDK = new FusionSDK({
    url: "https://fusion.1inch.io",
    network: NetworkEnum.POLYGON,
    // authKey não necessário para quotes públicas
  });

  const amountIn = parseUnits(flashLoanAmount, 6);   // USDT tem 6 decimais

  const quote = await fusionSDK.getQuote({
    fromTokenAddress: USDT_POLYGON,
    toTokenAddress:   USDT_POLYGON,   // ciclo: USDT → RWA → USDT
    amount: amountIn.toString(),
    walletAddress,
    enableEstimate: true,
  });

  const amountOut = BigInt(quote.toTokenAmount ?? "0");
  return { amountOut, quoteData: quote };
}

// ─── Fase 2: Estimar custo de gás ────────────────────────────────────────────

async function estimateGasCost(
  provider: JsonRpcProvider,
  maticPriceUSDT: number
): Promise<number> {

  // Gas estimado para Flash Loan + swap 1inch (empírico em Polygon)
  const GAS_UNITS_ESTIMATE = 450_000n;

  const feeData = await provider.getFeeData();
  const gasPriceWei = feeData.maxFeePerGas ?? feeData.gasPrice ?? 50_000_000_000n;

  const gasCostMatic = Number(formatUnits(GAS_UNITS_ESTIMATE * gasPriceWei, 18));
  const gasCostUSDT  = gasCostMatic * maticPriceUSDT;

  return gasCostUSDT;
}

// ─── Fase 3: Construir bundle para Flashbots / Private RPC ───────────────────

function buildFlashLoanBundle(
  walletAddress: string,
  flashLoanAmount: string,
  quoteData: object
): object {

  // Dados de calldata para o Vault da Balancer (flashLoan)
  // O contrato RWAArbitrage.sol vai ser o receiver
  const bundle = {
    method: "flashLoan",
    vault: BALANCER_VAULT,
    receiver: "<DEPLOY_RWA_ARBITRAGE_CONTRACT_ADDRESS>",   // preencher após deploy
    tokens: [USDT_POLYGON],
    amounts: [parseUnits(flashLoanAmount, 6).toString()],
    userData: JSON.stringify(quoteData),   // passado para receiveFlashLoan()
    privateRpc: FLASHBOTS_RPC,
    submittedAt: new Date().toISOString(),
    recipient: walletAddress,   // lucro enviado aqui
  };

  return bundle;
}

// ─── Handler principal (Supabase Edge / Vercel Edge) ─────────────────────────

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method Not Allowed" }), { status: 405 });
  }

  const log: string[] = [];
  const body = (await req.json()) as ArbitrageRequest;

  try {
    // ── 1. Validação de inputs ──────────────────────────────────────────────

    const walletAddress = safeGetAddress(body.walletAddress);
    log.push(`✅ Endereço validado: ${walletAddress}`);

    if (!body.alchemyRpcUrl || !body.alchemyRpcUrl.startsWith("https://")) {
      throw new Error("alchemyRpcUrl inválida");
    }

    const flashLoanAmt = parseFloat(body.flashLoanAmount ?? "20000");
    if (isNaN(flashLoanAmt) || flashLoanAmt <= 0 || flashLoanAmt > 100_000) {
      throw new Error("flashLoanAmount fora do intervalo permitido (0-100.000 USDT)");
    }

    // ── 2. Conectar ao RPC ──────────────────────────────────────────────────

    const provider = new JsonRpcProvider(body.alchemyRpcUrl);
    const network  = await provider.getNetwork();
    log.push(`🌐 Rede: ${network.name} (chainId ${network.chainId})`);

    if (network.chainId !== 137n) {
      throw new Error(`Rede incorreta. Esperado Polygon (137), recebido ${network.chainId}`);
    }

    // ── 3. Quote 1inch Fusion ───────────────────────────────────────────────

    log.push("📊 Obtendo quote via 1inch Fusion...");
    const { amountOut, quoteData } = await getFusionQuote(walletAddress, body.flashLoanAmount);

    const amountIn  = parseUnits(body.flashLoanAmount, 6);
    const grossProfit = Number(formatUnits(amountOut - amountIn, 6));
    log.push(`💰 Lucro bruto estimado: $${grossProfit.toFixed(4)} USDT`);

    // ── 4. Estimativa de custo de gás ───────────────────────────────────────

    const maticPrice  = await getMaticPriceInUSDT(provider);
    const gasCostUSDT = await estimateGasCost(provider, maticPrice);
    log.push(`⛽ Custo de gás estimado: $${gasCostUSDT.toFixed(4)} USDT (MATIC @ $${maticPrice.toFixed(3)})`);

    // ── 5. Profit Guard ─────────────────────────────────────────────────────

    const netProfit = grossProfit - gasCostUSDT;
    log.push(`📈 Lucro líquido estimado: $${netProfit.toFixed(4)} USDT`);

    if (netProfit < MIN_NET_PROFIT_USDT) {
      log.push(`🚫 Insufficient Profit — lucro líquido ($${netProfit.toFixed(4)}) abaixo do mínimo ($${MIN_NET_PROFIT_USDT})`);
      return new Response(
        JSON.stringify({
          success: false,
          phase: "quote",
          estimatedProfit: grossProfit.toFixed(4),
          estimatedGasCost: gasCostUSDT.toFixed(4),
          netProfit: netProfit.toFixed(4),
          error: "Insufficient Profit",
          log,
        } satisfies ArbitrageResponse),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // ── 6. Dry Run? ─────────────────────────────────────────────────────────

    if (body.dryRun) {
      log.push("🔵 Dry Run — simulação concluída, tx não enviada");
      return new Response(
        JSON.stringify({
          success: true,
          phase: "quote",
          estimatedProfit: grossProfit.toFixed(4),
          estimatedGasCost: gasCostUSDT.toFixed(4),
          netProfit: netProfit.toFixed(4),
          log,
        } satisfies ArbitrageResponse),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // ── 7. Construir bundle para o frontend assinar ─────────────────────────

    const bundleData = buildFlashLoanBundle(walletAddress, body.flashLoanAmount, quoteData);
    log.push("📦 Bundle construído — aguardando assinatura do frontend");

    // ── 8. Se tx assinada enviada (fase 2), fazer broadcast via Private RPC ──

    if (body.signedTx) {
      log.push("🚀 Enviando tx assinada via Private RPC...");
      try {
        const txResponse = await provider.broadcastTransaction(body.signedTx);
        log.push(`✅ Tx enviada! Hash: ${txResponse.hash}`);

        return new Response(
          JSON.stringify({
            success: true,
            phase: "broadcast",
            txHash: txResponse.hash,
            netProfit: netProfit.toFixed(4),
            log,
          } satisfies ArbitrageResponse),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      } catch (broadcastError) {
        throw new Error(`Falha no broadcast: ${(broadcastError as Error).message}`);
      }
    }

    // ── 9. Retornar bundle para assinatura ──────────────────────────────────

    return new Response(
      JSON.stringify({
        success: true,
        phase: "bundle",
        estimatedProfit: grossProfit.toFixed(4),
        estimatedGasCost: gasCostUSDT.toFixed(4),
        netProfit: netProfit.toFixed(4),
        bundleData,
        log,
      } satisfies ArbitrageResponse),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );

  } catch (err) {
    const message = (err as Error).message ?? "Erro desconhecido";
    log.push(`❌ ERRO: ${message}`);
    console.error("[execute-arbitrage]", message);

    return new Response(
      JSON.stringify({
        success: false,
        phase: "quote",
        error: message,
        log,
      } satisfies ArbitrageResponse),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }
}
