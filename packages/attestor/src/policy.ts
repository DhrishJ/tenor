/**
 * Tenor policy adjustments, applied AFTER the ChainScore score and labelled as
 * Tenor's, never as ChainScore's.
 *
 *   ChainScore score  what the upstream returned (aggregated across chains)
 *   Tenor adjustment  each rule below, itemized
 *   Tenor score       the number that is signed and goes on-chain
 *
 * The on-chain registry already does the time-critical part: a Tenor
 * liquidation invalidates the current score at once, and any attestation
 * issued before it is rejected. This module decides what the NEXT score looks
 * like, and never contradicts the registry.
 *
 * Units: ChainScore's score band is points-to-double-odds with PDO = 72.2
 * (model_meta.json, score_band.pdo, commit a519058). So 72 points is "treat as
 * twice the odds of liquidation". The penalty is expressed in the model's own
 * scale rather than chosen for demo effect. The size and windows below are
 * still POLICY PLACEHOLDERS, not calibrated.
 */
export const POINTS_PER_DOUBLED_ODDS = 72
export const PENALTY_WINDOW_SECONDS = 180 * 24 * 60 * 60
export const MAX_PENALIZED_LIQUIDATIONS = 3
/** Highest FLOOR score (RiskParams: D starts at 452). */
export const SHORTFALL_CAP = 451

export interface LiquidationRecord {
  lastLiquidatedAt: number
  liquidationCount: number
  shortfallCount: number
  totalShortfall: bigint
}

export interface Adjustment {
  rule: 'tenor-liquidation' | 'tenor-shortfall-cap' | 'range-clamp'
  points: number
  detail: string
}

export interface PolicyResult {
  adjustments: Adjustment[]
  tenorScore: number
}

export function applyTenorPolicy(chainscoreScore: number, rec: LiquidationRecord, nowSec: number): PolicyResult {
  const adjustments: Adjustment[] = []
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
      rule: 'tenor-liquidation',
      points,
      detail: `${rec.liquidationCount} Tenor liquidation(s), latest within 180 days: -${POINTS_PER_DOUBLED_ODDS} points each (doubled liquidation odds), max ${MAX_PENALIZED_LIQUIDATIONS}`,
    })

    if (rec.shortfallCount > 0 && score > SHORTFALL_CAP) {
      const points = SHORTFALL_CAP - score
      score = SHORTFALL_CAP
      adjustments.push({
        rule: 'tenor-shortfall-cap',
        points,
        detail: `${rec.shortfallCount} Tenor liquidation(s) left bad debt: capped at ${SHORTFALL_CAP} (floor tier) while within 180 days`,
      })
    }
  }

  if (score < 300) {
    adjustments.push({ rule: 'range-clamp', points: 300 - score, detail: 'clamped to the 300 minimum' })
    score = 300
  }
  return { adjustments, tenorScore: score }
}
