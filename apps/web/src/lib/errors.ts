import { BaseError, ContractFunctionRevertedError } from 'viem'

/** Specific, human messages for every revert a user can hit. No generic toasts. */
const MESSAGES: Record<string, string> = {
  ExceedsMaxLtv: 'That amount is above your tier’s maximum LTV for the collateral posted. Use Max, or add collateral.',
  ExceedsWalletCap: 'That amount is above your tier’s per-wallet borrow cap.',
  ExceedsTierCap: 'Your tier’s total borrow cap across all wallets is reached. Try a smaller amount.',
  ExceedsGlobalCap: 'The market’s global borrow cap is reached.',
  InsufficientLiquidity: 'Not enough idle tUSD in the pool for that amount.',
  InsufficientCollateral: 'You cannot withdraw more collateral than you posted.',
  NotLiquidatable: 'This position is healthy: it cannot be liquidated.',
  NoDebt: 'There is no debt on this position.',
  ZeroAmount: 'Enter an amount greater than zero.',
  StalePrice: 'The mock oracle price is stale. Borrowing, liquidation and collateral withdrawal against debt are paused until it is refreshed.',
  InvalidPrice: 'The mock oracle has no valid price.',
  EnforcedPause: 'The market is paused: borrowing and liquidation are disabled. Repay and withdrawals still work.',
  ERC20InsufficientBalance: 'Insufficient token balance. Use the faucet to get test tokens.',
  ERC20InsufficientAllowance: 'Approval missing: approve the token first.',
  InvalidSigner: 'The registry rejected the signature (wrong signer or tampered payload).',
  InvalidNonce: 'This attestation’s nonce is already used. Request a fresh attestation.',
  DeadlinePassed: 'This attestation’s 15-minute submit window has passed. Request a fresh one.',
  AttestationExpired: 'This attestation has expired. Request a fresh one.',
  IssuedInFuture: 'The chain’s clock is behind the score’s computation time by more than a minute. Wait a moment and submit again.',
  TtlTooLong: 'This attestation’s validity exceeds the registry’s 48-hour maximum.',
  ScoreOutOfRange: 'The score is outside 300–850; the registry rejects it.',
  NotNewer: 'A score with the same or newer data is already on-chain.',
  IssuedBeforeLiquidation: 'This score was computed before your latest Tenor liquidation, so the registry rejects it. Request a fresh, adjusted score.',
  FaucetCooldown: 'Faucet cooldown: one claim per hour per address.',
}

export function explainError(e: unknown): string {
  if (e instanceof BaseError) {
    const revert = e.walk((x) => x instanceof ContractFunctionRevertedError)
    if (revert instanceof ContractFunctionRevertedError) {
      const name = revert.data?.errorName
      if (name && MESSAGES[name]) return MESSAGES[name]!
      if (name) return `Transaction would revert: ${name}.`
    }
    if (/User rejected|denied/i.test(e.message)) return 'You rejected the request in your wallet.'
    return e.shortMessage
  }
  return e instanceof Error ? e.message : String(e)
}
