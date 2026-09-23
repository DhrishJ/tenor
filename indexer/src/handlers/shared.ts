import type { MarketTotals, Wallet } from 'envio'

export const TIERS = ['FLOOR', 'D', 'C', 'B', 'A'] as const

/** Same boundaries as contracts/src/RiskParams.sol scoreToTier (display only). */
export function scoreToTier(score: number): string {
  if (score >= 774) return 'A'
  if (score >= 643) return 'B'
  if (score >= 578) return 'C'
  if (score >= 452) return 'D'
  return 'FLOOR'
}

export const tierName = (index: bigint | number) => TIERS[Number(index)] ?? `UNKNOWN(${index})`

export const eventId = (txHash: string, logIndex: number) => `${txHash}-${logIndex}`

export function newWallet(id: string): Wallet {
  return {
    id,
    attestationCount: 0,
    latestScore: undefined,
    latestScoreIssuedAt: undefined,
    latestScoreExpiresAt: undefined,
    borrowCount: 0,
    liquidationCount: 0,
    shortfallCount: 0,
    totalShortfall: 0n,
    lastLiquidatedAt: undefined,
  }
}

export function newTotals(now: bigint): MarketTotals {
  return {
    id: 'market',
    lenderDeposits: 0n,
    lenderWithdrawals: 0n,
    borrowVolume: 0n,
    repayVolume: 0n,
    borrowCount: 0,
    liquidationCount: 0,
    liquidationsWithShortfall: 0,
    badDebt: 0n,
    badDebtFromReserves: 0n,
    badDebtSocialized: 0n,
    interestAccrued: 0n,
    toReserves: 0n,
    attestationCount: 0,
    lastBorrowIndex: undefined,
    updatedAt: now,
  }
}
