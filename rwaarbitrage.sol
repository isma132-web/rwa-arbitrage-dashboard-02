// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title  RWAArbitrage
 * @notice Flash Loan arbitrage via Balancer V2 + 1inch Fusion no mercado de RWAs
 * @dev    Deploy na Polygon Mainnet (chainId 137)
 *         Balancer V2 Vault: 0xBA12222222228d8Ba445958a75a0704d566BF2C8
 *
 * Fluxo:
 *   1. Owner chama initiateFlashLoan()
 *   2. Balancer Vault empresta USDT sem taxa
 *   3. Vault chama receiveFlashLoan() neste contrato
 *   4. Contrato troca USDT → RWA → USDT via 1inch Fusion
 *   5. Contrato devolve o principal ao Vault
 *   6. Lucro líquido é transferido para o owner
 */

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

// ─── Interfaces Balancer V2 ───────────────────────────────────────────────────

interface IBalancerVault {
    function flashLoan(
        IFlashLoanRecipient recipient,
        IERC20[] memory tokens,
        uint256[] memory amounts,
        bytes memory userData
    ) external;
}

interface IFlashLoanRecipient {
    function receiveFlashLoan(
        IERC20[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,   // sempre 0 na Balancer V2
        bytes memory userData
    ) external;
}

// ─── Interface 1inch AggregationRouter v6 ────────────────────────────────────

interface I1inchRouter {
    struct SwapDescription {
        IERC20  srcToken;
        IERC20  dstToken;
        address payable srcReceiver;
        address payable dstReceiver;
        uint256 amount;
        uint256 minReturnAmount;
        uint256 flags;
    }

    function swap(
        address executor,
        SwapDescription calldata desc,
        bytes calldata permit,
        bytes calldata data
    ) external payable returns (uint256 returnAmount, uint256 spentAmount);
}

// ─── Contrato Principal ───────────────────────────────────────────────────────

contract RWAArbitrage is IFlashLoanRecipient, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── Endereços imutáveis (Polygon Mainnet) ────────────────────────────────

    IBalancerVault public immutable BALANCER_VAULT;
    I1inchRouter   public immutable INCH_ROUTER;
    IERC20         public immutable USDT;

    // ── Parâmetros configuráveis ─────────────────────────────────────────────

    uint256 public minProfitUSDT = 1_500_000;   // 1.50 USDT (6 decimais)

    // ── Eventos ──────────────────────────────────────────────────────────────

    event ArbitrageExecuted(
        address indexed initiator,
        uint256 loanAmount,
        uint256 profit,
        address indexed rwaToken
    );
    event InsufficientProfit(uint256 returned, uint256 loanAmount);
    event MinProfitUpdated(uint256 oldValue, uint256 newValue);

    // ── Erros customizados (economizam gás vs require strings) ───────────────

    error OnlyVault();
    error InsufficientProfitError(uint256 profit, uint256 minRequired);
    error ZeroAmountNotAllowed();
    error TokenTransferFailed();

    // ── Constructor ──────────────────────────────────────────────────────────

    constructor(
        address _balancerVault,
        address _1inchRouter,
        address _usdt
    ) Ownable(msg.sender) {
        BALANCER_VAULT = IBalancerVault(_balancerVault);
        INCH_ROUTER    = I1inchRouter(_1inchRouter);
        USDT           = IERC20(_usdt);
    }

    // ── Passo 1: Owner inicia o Flash Loan ───────────────────────────────────

    /**
     * @param loanAmount   Quantidade de USDT a pegar emprestado (6 decimais)
     * @param rwaToken     Endereço do token RWA no mercado secundário
     * @param swapDataIn   Calldata da 1inch: USDT → RWA
     * @param swapDataOut  Calldata da 1inch: RWA → USDT
     */
    function initiateFlashLoan(
        uint256 loanAmount,
        address rwaToken,
        bytes calldata swapDataIn,
        bytes calldata swapDataOut
    ) external nonReentrant onlyOwner {
        if (loanAmount == 0) revert ZeroAmountNotAllowed();

        IERC20[] memory tokens  = new IERC20[](1);
        uint256[] memory amounts = new uint256[](1);
        tokens[0]  = USDT;
        amounts[0] = loanAmount;

        // userData = abi.encode dos parâmetros para receiveFlashLoan
        bytes memory userData = abi.encode(rwaToken, swapDataIn, swapDataOut);

        BALANCER_VAULT.flashLoan(this, tokens, amounts, userData);
    }

    // ── Passo 2: Callback executado pelo Balancer Vault ──────────────────────

    /**
     * @dev  Chamado pelo Vault após liberar os tokens.
     *       Deve devolver amounts[i] + feeAmounts[i] para cada token.
     *       Fee da Balancer V2 = 0%.
     */
    function receiveFlashLoan(
        IERC20[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory userData
    ) external override nonReentrant {
        // ── Segurança: só o Vault pode chamar este callback ──────────────────
        if (msg.sender != address(BALANCER_VAULT)) revert OnlyVault();

        // ── Decodificar parâmetros passados pelo initiateFlashLoan ───────────
        (
            address rwaToken,
            bytes memory swapDataIn,
            bytes memory swapDataOut
        ) = abi.decode(userData, (address, bytes, bytes));

        uint256 loanAmount = amounts[0];
        uint256 feeDue     = feeAmounts[0];   // = 0 na Balancer V2

        // ── Swap 1: USDT → RWA ───────────────────────────────────────────────
        USDT.safeIncreaseAllowance(address(INCH_ROUTER), loanAmount);

        I1inchRouter.SwapDescription memory descIn = I1inchRouter.SwapDescription({
            srcToken:        USDT,
            dstToken:        IERC20(rwaToken),
            srcReceiver:     payable(address(this)),
            dstReceiver:     payable(address(this)),
            amount:          loanAmount,
            minReturnAmount: 1,   // slippage mínimo; valor real vem do quote
            flags:           0
        });

        (uint256 rwaReceived, ) = INCH_ROUTER.swap(
            address(0),   // executor padrão
            descIn,
            "",
            swapDataIn
        );

        // ── Swap 2: RWA → USDT ───────────────────────────────────────────────
        IERC20(rwaToken).safeIncreaseAllowance(address(INCH_ROUTER), rwaReceived);

        I1inchRouter.SwapDescription memory descOut = I1inchRouter.SwapDescription({
            srcToken:        IERC20(rwaToken),
            dstToken:        USDT,
            srcReceiver:     payable(address(this)),
            dstReceiver:     payable(address(this)),
            amount:          rwaReceived,
            minReturnAmount: loanAmount + feeDue + minProfitUSDT,   // Profit Guard
            flags:           0
        });

        (uint256 usdtReceived, ) = INCH_ROUTER.swap(
            address(0),
            descOut,
            "",
            swapDataOut
        );

        // ── Profit Guard on-chain ─────────────────────────────────────────────
        uint256 repayAmount = loanAmount + feeDue;
        if (usdtReceived < repayAmount + minProfitUSDT) {
            emit InsufficientProfit(usdtReceived, repayAmount);
            revert InsufficientProfitError(
                usdtReceived > repayAmount ? usdtReceived - repayAmount : 0,
                minProfitUSDT
            );
        }

        uint256 profit = usdtReceived - repayAmount;

        // ── Devolver principal ao Vault ───────────────────────────────────────
        USDT.safeTransfer(address(BALANCER_VAULT), repayAmount);

        // ── Enviar lucro líquido ao owner ────────────────────────────────────
        USDT.safeTransfer(owner(), profit);

        emit ArbitrageExecuted(owner(), loanAmount, profit, rwaToken);
    }

    // ── Admin: atualizar lucro mínimo ─────────────────────────────────────────

    function setMinProfitUSDT(uint256 _minProfit) external onlyOwner {
        emit MinProfitUpdated(minProfitUSDT, _minProfit);
        minProfitUSDT = _minProfit;
    }

    // ── Saque de emergência ───────────────────────────────────────────────────

    function emergencyWithdraw(address token) external onlyOwner {
        uint256 bal = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransfer(owner(), bal);
    }

    // ── Bloquear recebimento de ETH acidental ────────────────────────────────

    receive() external payable {
        revert("ETH not accepted");
    }
}
