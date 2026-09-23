import { getAddress, keccak256, toHex, type Address } from 'viem'
import type { ChainScoreClient, ChainScoreResult, UpstreamResponse } from '../src/chainscore.js'
import { COVERED_CHAINS, type ChainSlug } from '../src/coverage.js'
import type { ChainHistory, HistoryChecker } from '../src/history.js'
import type { LiquidationRecord } from '../src/policy.js'
import type { OnChainScore, RegistryReader } from '../src/registry.js'
import { AttestationService } from '../src/service.js'
import { AttestationSigner } from '../src/signer.js'
import { MemoryStore } from '../src/store.js'
import { silentLogger } from '../src/log.js'

/** Every covered chain checked by HyperSync, no borrowing found. */
function noBorrowingAnywhere(): Record<ChainSlug, ChainHistory> {
  const r = {} as Record<ChainSlug, ChainHistory>
  for (const c of COVERED_CHAINS) r[c.slug] = { ok: true, aaveBorrows: 0, compoundBorrows: 0, source: 'hypersync', unverified: [] }
  return r
}

export const WALLET: Address = getAddress('0x04383b40611ee9408cb6fb8a6bb0d66b07ca7e09')
/** Test-only key, derived from a label; controls nothing. */
export const SIGNER_KEY = keccak256(toHex('tenor attestor unit-test key'))
export const DOMAIN = {
  name: 'Tenor ScoreRegistry',
  version: '1',
  chainId: 10143,
  verifyingContract: getAddress('0x440ad250af73e2c45b7f382129623ce198057406'),
}
export const NOW_MS = 1_790_000_000_000

export function noHistory(): Record<ChainSlug, ChainHistory> {
  return noBorrowingAnywhere()
}

export class FakeHistory implements HistoryChecker {
  calls = 0
  constructor(public result: Record<ChainSlug, ChainHistory> = noHistory()) {}
  async check() {
    this.calls++
    return this.result
  }
}

export function goodUpstream(over: Partial<ChainScoreResult> = {}): UpstreamResponse {
  return {
    ok: true,
    data: {
      score: 780,
      newWallet: false,
      walletAge: 801,
      totalTxns: 188,
      protocolsUsed: ['Aave'],
      degradedSources: [],
      timestamp: NOW_MS - 1_000,
      modelVersion: 'v5-xgb-cal',
      ...over,
    },
  }
}

export class FakeChainScore implements ChainScoreClient {
  calls: ChainSlug[] = []
  constructor(public byChain: Partial<Record<ChainSlug, UpstreamResponse | (() => UpstreamResponse)>> = {}) {}
  async score(_w: Address, chain: ChainSlug) {
    this.calls.push(chain)
    const r = this.byChain[chain]
    if (!r) return { ok: false as const, error: `no fake for ${chain}` }
    return typeof r === 'function' ? r() : r
  }
}

export class FakeRegistry implements RegistryReader {
  nonceValue = 0n
  record: LiquidationRecord = { lastLiquidatedAt: 0, liquidationCount: 0, shortfallCount: 0, totalShortfall: 0n }
  recordSequence: LiquidationRecord[] = []
  onChain: OnChainScore = { score: 0, issuedAt: 0, expiresAt: 0, isStale: true }
  async nonce() {
    return this.nonceValue
  }
  async attestor() {
    return new AttestationSigner(SIGNER_KEY, DOMAIN).address
  }
  async liquidationRecord() {
    return this.recordSequence.shift() ?? this.record
  }
  async onChainScore() {
    return this.onChain
  }
}

export function makeService(opts: { history?: FakeHistory; chainscore?: FakeChainScore; registry?: FakeRegistry; now?: () => number } = {}) {
  const history = opts.history ?? new FakeHistory()
  const chainscore = opts.chainscore ?? new FakeChainScore()
  const registry = opts.registry ?? new FakeRegistry()
  const store = new MemoryStore()
  const signer = new AttestationSigner(SIGNER_KEY, DOMAIN)
  let signCalls = 0
  const origSign = signer.sign.bind(signer)
  signer.sign = (a) => {
    signCalls++
    return origSign(a)
  }
  const service = new AttestationService({
    history,
    chainscore,
    registry,
    signer,
    store,
    log: silentLogger,
    now: opts.now ?? (() => NOW_MS),
    scoreTtlSeconds: 86_400,
    submitWindowSeconds: 900,
  })
  return { service, history, chainscore, registry, store, signer, signCalls: () => signCalls }
}

export function withBorrows(chains: Partial<Record<ChainSlug, number>>) {
  const h = noHistory()
  for (const [c, n] of Object.entries(chains)) h[c as ChainSlug] = { ok: true, aaveBorrows: n ?? 0, compoundBorrows: 0, source: 'hypersync', unverified: [] }
  return h
}
