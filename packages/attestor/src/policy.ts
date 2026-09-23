/**
 * Tenor policy, applied AFTER the ChainScore score and labelled as Tenor's,
 * never as ChainScore's. Two different kinds of thing, kept apart everywhere
 * (service response, logs, UI):
 *
 *   adjustments  point changes in the MODEL'S units
 *   policyCaps   ceilings set by POLICY, not by the model
 *
 *   ChainScore score  what the upstream returned (aggregated across chains)
 *   + adjustments     e.g. -72 per recent Tenor liquidation
 *   capped by caps    e.g. at most tier C after a Tenor liquidation
 *   = Tenor score     the number that is signed and goes on-chain
 *
 * On-chain, the signed score is the only channel, so a cap is enacted as a
 * score ceiling (the registry derives the tier from the score). The response
 * still reports it as a cap, with its own line.
 *
 * Units for adjustments: ChainScore's score band is points-to-double-odds with
 * PDO = 72.2 (model_meta.json, score_band.pdo, commit a519058). So -72 points
 * is "treat as twice the odds of liquidation". Sizes and windows are POLICY
 * PLACEHOLDERS, not calibrated.
 *
 * The registry already does the time-critical part: a Tenor liquidation
 * invalidates the current score on-chain at once. This module shapes the NEXT
 * score and never contradicts the registry.
 */
import { scoreToTier, type Tier } from './tiers.js'

export const POINTS_PER_DOUBLED_ODDS = 72
export const PENALTY_WINDOW_SECONDS = 180 * 24 * 60 * 60
export const MAX_PENALIZED_LIQUIDATIONS = 3
/** Top of tier C (RiskParams: B starts at 643). */
export const LIQUIDATION_TIER_CAP = 642
/** Top of FLOOR (RiskParams: D starts at 452). */
export const SHORTFALL_CAP = 451
export const MIN_SCORE = 300

export interface LiquidationRecord {
  lastLiquidatedAt: number
  liquidationCount: number
  shortfallCount: number
  totalShortfall: bigint
}

export interface Adjustment {
  rule: 'tenor-liquidation-penalty'
  points: number
  detail: string
}

export interface PolicyCap {
  rule: 'tenor-liquidation-tier-cap' | 'tenor-shortfall-cap'
  maxScore: number
  maxTier: Tier
  /** True if the cap lowered the score (the score was above it). */
  binding: boolean
  detail: string
}

export interface PolicyResult {
  adjustments: Adjustment[]
  policyCaps: PolicyCap[]
  tenorScore: number
}

export function applyTenorPolicy(chainscoreScore: number, rec: LiquidationRecord, nowSec: number): PolicyResult {
  const adjustments: Adjustment[] = []
  const policyCaps: PolicyCap[] = []
  let score = chainscoreScore
  const recent = rec.liquidationCount > 0 && nowSec - rec.lastLiquidatedAt < PENALTY_WINDOW_SECONDS

  if (recent) {
    // The registry keeps counts and the latest timestamp, not a per-event
    // history, so the lifetime count is penalized while the latest liquidation
    // is inside the window.
    const n = Math.min(rec.liquidationCount, MAX_PENALIZED_LIQUIDATIONS)
    const points = -POINTS_PER_DOUBLED_ODDS * n
    score += points
    adjustments.push({
      rule: 'tenor-liquidation-penalty',
      points,
      detail: `${rec.liquidationCount} Tenor liquidation(s), latest within 180 days: -${POINTS_PER_DOUBLED_ODDS} points each (the model's scale: doubled liquidation odds), at most ${MAX_PENALIZED_LIQUIDATIONS}`,
    })

    const caps: Array<Omit<PolicyCap, 'binding'>> = [
      {
        rule: 'tenor-liquidation-tier-cap',
        maxScore: LIQUIDATION_TIER_CAP,
        maxTier: 'C',
        detail: 'Tenor policy: at most tier C for 180 days after a Tenor liquidation',
      },
    ]
    if (rec.shortfallCount > 0) {
      caps.push({
        rule: 'tenor-shortfall-cap',
        maxScore: SHORTFALL_CAP,
        maxTier: 'FLOOR',
        detail: `Tenor policy: floor tier for 180 days after a Tenor liquidation that left bad debt (${rec.shortfallCount} so far)`,
      })
    }
    for (const cap of caps) {
      const binding = score > cap.maxScore
      if (binding) score = cap.maxScore
      policyCaps.push({ ...cap, binding })
    }
  }

  if (score < MIN_SCORE) score = MIN_SCORE
  return { adjustments, policyCaps, tenorScore: score }
}

/** Shown when a cap binds: the tier the adjustments alone would have given. */
export function tierBeforeCaps(chainscoreScore: number, adjustments: Adjustment[]): Tier {
  return scoreToTier(Math.max(MIN_SCORE, chainscoreScore + adjustments.reduce((s, a) => s + a.points, 0)))
}
