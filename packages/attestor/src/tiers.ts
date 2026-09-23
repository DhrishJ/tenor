/**
 * Display-only mirror of contracts/src/RiskParams.sol scoreToTier. The chain is
 * authoritative; the local end-to-end test checks this mirror against
 * ScoreRegistry.effectiveTier on a deployed registry.
 */
export type Tier = 'FLOOR' | 'D' | 'C' | 'B' | 'A'

export function scoreToTier(score: number): Tier {
  if (score >= 774) return 'A'
  if (score >= 643) return 'B'
  if (score >= 578) return 'C'
  if (score >= 452) return 'D'
  return 'FLOOR'
}

/** Solidity enum order: FLOOR=0 ... A=4. */
export const TIER_INDEX: Record<Tier, number> = { FLOOR: 0, D: 1, C: 2, B: 3, A: 4 }
