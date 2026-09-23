/**
 * Per-chain validation of a ChainScore result, for a chain where the
 * independent history check found borrowing. Returns either a score Tenor may
 * count, or the reason it may not.
 *
 * Order matters only for which reason is reported first; every failure means
 * the chain cannot be counted, and because the aggregate is a minimum, an
 * uncountable chain with borrowing makes the whole wallet UNAVAILABLE (a chain
 * we cannot read might hold the liquidation that would lower the minimum).
 */
import type { ChainHistory } from './history.js'
import type { UpstreamResponse } from './chainscore.js'
import type { CoveredChain } from './coverage.js'

export const MIN_SCORE = 300
export const MAX_SCORE = 850

/** How far the upstream's computation time may sit from our clock. The legacy
 *  endpoint computes on request, so anything outside this is implausible. */
export const MAX_UPSTREAM_CLOCK_DRIFT_MS = 10 * 60 * 1000

export type ChainValidation =
  | { counted: true; score: number; computedAtMs: number; modelVersion: string | undefined }
  | { counted: false; reason: string; check: FailedCheck }

export type FailedCheck =
  | 'upstream-error'
  | 'provider-health'
  | 'history-mismatch'
  | 'consistency'
  | 'range'
  | 'sentinel'
  | 'freshness'

export function validateChain(
  chain: CoveredChain,
  history: Extract<ChainHistory, { ok: true }>,
  upstream: UpstreamResponse,
  nowMs: number,
): ChainValidation {
  const borrows = history.aaveBorrows + history.compoundBorrows
  const fail = (check: FailedCheck, reason: string): ChainValidation => ({ counted: false, check, reason })

  if (!upstream.ok) return fail('upstream-error', `${chain.name}: ${upstream.error}`)
  const d = upstream.data

  // (b) Provider health, on a chain where the wallet has borrowed.
  if (d.degradedSources && d.degradedSources.length > 0) {
    return fail('provider-health', `${chain.name} data unavailable (${d.degradedSources.join(', ')} degraded at ChainScore)`)
  }

  // (a) Independent history disagrees with ChainScore.
  if (d.newWallet || d.noBorrowHistory) {
    return fail(
      'history-mismatch',
      `${chain.name}: ChainScore reports no borrowing history, but ${borrows} borrow(s) were found on-chain`,
    )
  }

  // (e) Consistency, the primary defense: a borrowing-derived score built on
  // an empty transaction history means a source failed without saying so.
  if (d.totalTxns === 0 || d.walletAge === 0) {
    return fail(
      'consistency',
      `${chain.name}: ChainScore's transaction history is empty for a wallet with ${borrows} on-chain borrow(s); an upstream data source failed without reporting it`,
    )
  }

  // (c) Range and sentinel.
  if (!Number.isInteger(d.score) || d.score < MIN_SCORE || d.score > MAX_SCORE) {
    return fail('range', `${chain.name}: ChainScore score ${d.score} is outside ${MIN_SCORE}-${MAX_SCORE}`)
  }
  if (d.score === MIN_SCORE && d.protocolsUsed.length === 0) {
    return fail('sentinel', `${chain.name}: score ${MIN_SCORE} with no supporting protocol history is a failure signal, not a score`)
  }

  // Freshness of the upstream's computation time.
  if (Math.abs(nowMs - d.timestamp) > MAX_UPSTREAM_CLOCK_DRIFT_MS) {
    return fail('freshness', `${chain.name}: ChainScore computation time is implausible (${new Date(d.timestamp).toISOString()})`)
  }

  return { counted: true, score: d.score, computedAtMs: d.timestamp, modelVersion: d.modelVersion }
}
