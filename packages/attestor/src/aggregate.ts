/**
 * Combining per-chain ChainScore scores into one number.
 *
 * ChainScore's model was trained and is served per (wallet, chain) pair. It
 * has NEVER been validated on a cross-chain combination. Whatever rule sits
 * here is Tenor's heuristic, not "the model's cross-chain score".
 */
import type { ChainSlug } from './coverage.js'

export interface ChainScoreEntry {
  chain: ChainSlug
  score: number
}

export interface AggregationRule {
  readonly name: string
  readonly description: string
  combine(entries: readonly ChainScoreEntry[]): number
}

/** Default. The wallet is as good as its worst chain: a liquidation on any
 *  covered chain pulls the result down, and no chain can be cherry-picked.
 *  A conservative heuristic, chosen because it cannot be gamed by adding a
 *  clean chain, not because it is calibrated. */
export const minimumRule: AggregationRule = {
  name: 'minimum',
  description: 'Lowest ChainScore across chains with verified borrowing history (conservative heuristic)',
  combine(entries) {
    if (entries.length === 0) throw new Error('minimumRule: no entries')
    return Math.min(...entries.map((e) => e.score))
  },
}
