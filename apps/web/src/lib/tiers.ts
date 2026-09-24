/**
 * Display mirror of contracts/src/RiskParams.sol. The chain is authoritative:
 * pages read effectiveTier / maxBorrow from the contracts; this table only
 * explains them.
 */
export type Tier = 'FLOOR' | 'D' | 'C' | 'B' | 'A'
export const TIERS: Tier[] = ['FLOOR', 'D', 'C', 'B', 'A']

export const TERMS: Record<Tier, { maxLtvBps: number; ltBps: number; walletCap: bigint; scores: string }> = {
  FLOOR: { maxLtvBps: 6000, ltBps: 6500, walletCap: 1_000n * 10n ** 18n, scores: 'unscored, stale, or 300–451' },
  D: { maxLtvBps: 6500, ltBps: 7000, walletCap: 2_500n * 10n ** 18n, scores: '452–577' },
  C: { maxLtvBps: 7000, ltBps: 7500, walletCap: 5_000n * 10n ** 18n, scores: '578–642' },
  B: { maxLtvBps: 7500, ltBps: 8000, walletCap: 10_000n * 10n ** 18n, scores: '643–773' },
  A: { maxLtvBps: 8000, ltBps: 8500, walletCap: 20_000n * 10n ** 18n, scores: '774–850' },
}

/** One phrase for "what an unscored or expired wallet can still do", used wherever a score is missing or stale. */
export const FLOOR_TERMS = `${TERMS.FLOOR.maxLtvBps / 100}% max LTV, up to ${(TERMS.FLOOR.walletCap / 10n ** 18n).toLocaleString('en-US')} tUSD per wallet`

export const tierFromIndex = (i: number | bigint): Tier => TIERS[Number(i)] ?? 'FLOOR'

export function scoreToTier(score: number): Tier {
  if (score >= 774) return 'A'
  if (score >= 643) return 'B'
  if (score >= 578) return 'C'
  if (score >= 452) return 'D'
  return 'FLOOR'
}
