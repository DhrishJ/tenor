/**
 * LOCAL DEVELOPMENT ONLY. Replays borrowing-history results recorded from
 * live HyperSync (fixtures/recorded-history-*.json) instead of querying it.
 * Used when HyperSync is unreachable from the developer's machine. When this
 * source is active, the HTTP layer adds a FIXTURE notice to every response,
 * and the frontend displays it. Never used in a deployed service.
 */
import { readFileSync } from 'node:fs'
import type { Address } from 'viem'
import { COVERED_CHAINS, type ChainSlug } from './coverage.js'
import type { ChainHistory, HistoryChecker } from './history.js'

interface Fixture {
  _source: string
  wallets: Record<string, Partial<Record<ChainSlug, { aaveBorrows: number; compoundBorrows: number }>>>
}

export class FixtureHistoryChecker implements HistoryChecker {
  readonly source: string
  private readonly wallets: Fixture['wallets']

  constructor(path: string) {
    const f = JSON.parse(readFileSync(path, 'utf8')) as Fixture
    this.source = f._source
    this.wallets = f.wallets
  }

  async check(wallet: Address) {
    const recorded = this.wallets[wallet.toLowerCase()]
    const out = {} as Record<ChainSlug, ChainHistory>
    for (const c of COVERED_CHAINS) {
      const r = recorded?.[c.slug]
      // A wallet not in the recording is reported as unknown, never as "no history".
      out[c.slug] = r
        ? { ok: true, aaveBorrows: r.aaveBorrows, compoundBorrows: r.compoundBorrows, source: 'hypersync', unverified: [] }
        : { ok: false, error: 'not in the recorded fixture', attempted: ['hypersync'] }
    }
    return out
  }
}
