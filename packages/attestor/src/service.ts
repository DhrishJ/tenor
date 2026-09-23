/**
 * The attestation service core. Framework-free: the HTTP adapter (http.ts) and,
 * later, Next.js route handlers call these two methods.
 *
 * Three outcomes, never collapsed into each other:
 *   SCORED                every check passed; /attest returns a signature
 *   INSUFFICIENT_HISTORY  no borrowing history on any covered chain; nothing
 *                         signed. The market still lends at FLOOR terms.
 *   UNAVAILABLE           a data source failed or disagreed; nothing signed,
 *                         and explicitly NOT a low score.
 */
import type { Address, Hex } from 'viem'
import { minimumRule, type AggregationRule } from './aggregate.js'
import type { ChainScoreClient } from './chainscore.js'
import { COVERED_CHAINS, chainBySlug, type ChainSlug } from './coverage.js'
import type { ChainHistory, HistoryChecker, HistorySource } from './history.js'
import { applyTenorPolicy, type Adjustment, type PolicyCap } from './policy.js'
import type { RegistryReader } from './registry.js'
import { modelVersionHash, type Attestation, type AttestationSigner } from './signer.js'
import type { Store } from './store.js'
import { scoreToTier, type Tier } from './tiers.js'
import { validateChain } from './validate.js'
import type { Logger } from './log.js'

export interface ChainNote {
  chain: ChainSlug
  name: string
  reason: string
}

export interface ContributingChain {
  chain: ChainSlug
  name: string
  chainscoreScore: number
  aaveBorrows: number
  compoundBorrows: number
  /** Which independent source verified borrowing here, or 'chainscore-only'
   *  when no independent source could check this chain (partial verification). */
  verifiedBy: HistorySource | 'chainscore-only'
}

export interface HistorySummary {
  /** 'full': every chain checked by an independent source with no gaps.
   *  'partial': at least one chain or protocol could not be checked. */
  verification: 'full' | 'partial'
  sources: Array<{ chain: ChainSlug; name: string; source: HistorySource | null; unverified: string[]; primaryError?: string }>
}

export type Evaluation =
  | {
      state: 'SCORED'
      /** What ChainScore returned, combined across chains by `aggregation`. */
      chainscoreScore: number
      aggregation: { rule: string; description: string }
      /** Tenor policy point adjustments (the model's units), itemized. Not ChainScore's. */
      adjustments: Adjustment[]
      /** Tenor policy caps (ceilings), itemized separately from adjustments. */
      policyCaps: PolicyCap[]
      /** chainscoreScore + adjustments, then capped: the number that is signed. */
      tenorScore: number
      tier: Tier
      /** When ChainScore computed the data (unix seconds), not signing time. */
      issuedAt: number
      expiresAt: number
      modelVersion: string
      contributingChains: ContributingChain[]
      excludedChains: ChainNote[]
      history: HistorySummary
    }
  | { state: 'INSUFFICIENT_HISTORY'; reason: string; excludedChains: ChainNote[]; history: HistorySummary }
  | { state: 'UNAVAILABLE'; reason: string; chains: ChainNote[]; history?: HistorySummary }

export type AttestResult =
  | (Extract<Evaluation, { state: 'SCORED' }> & {
      attestation: SerializedAttestation | null
      signature: Hex | null
      /** Same payload re-signed because an unexpired reservation exists for this nonce. */
      reusedReservation: boolean
      /** The identical score is already on-chain and fresh; nothing to sign. */
      alreadyOnChain: boolean
    })
  | Exclude<Evaluation, { state: 'SCORED' }>

/** JSON-safe form of the struct the frontend passes to submitAttestation. */
export interface SerializedAttestation {
  wallet: Address
  score: number
  issuedAt: string
  expiresAt: string
  deadline: string
  nonce: string
  modelVersion: Hex
}

export interface ServiceDeps {
  history: HistoryChecker
  chainscore: ChainScoreClient
  registry: RegistryReader
  signer: AttestationSigner
  store: Store
  log: Logger
  aggregation?: AggregationRule
  now?: () => number
  /** Validity of a score after ChainScore computed it. 24 h: see ttl note below. */
  scoreTtlSeconds: number
  /** How long a signed payload may wait before submission. */
  submitWindowSeconds: number
}

/*
 * TTL note (24 h). Tenor's own liquidations invalidate a score on-chain
 * instantly, so the TTL only covers what Tenor cannot see: a wallet liquidated
 * on Aave or Compound keeps its Tenor terms until its score expires. That
 * exposure is bounded by the per-wallet and per-tier caps (CONTRACTS.md 9.1).
 * A shorter TTL narrows the window but makes users re-attest more often, and
 * every re-attestation spends ChainScore requests (20/min per IP on the
 * endpoint in use). 24 h is also well inside the on-chain maximum of 48 h.
 */

export class AttestationService {
  private readonly aggregation: AggregationRule
  private readonly now: () => number
  private readonly locks = new Map<string, Promise<unknown>>()

  constructor(private readonly d: ServiceDeps) {
    this.aggregation = d.aggregation ?? minimumRule
    this.now = d.now ?? Date.now
  }

  /** Display only: the full breakdown, never a signature. */
  async evaluate(wallet: Address, requestId: string, endpoint = 'score'): Promise<Evaluation> {
    const ev = await this.evaluateInner(wallet, false)
    if (ev.state !== 'SCORED') await this.logRefusal(ev, wallet, requestId, endpoint)
    return ev
  }

  /** Evaluate, then sign if SCORED. Serialized per wallet within this process;
   *  the store's reservation makes it safe across processes. */
  attest(wallet: Address, requestId: string): Promise<AttestResult> {
    return this.withWalletLock(wallet, () => this.attestInner(wallet, requestId))
  }

  // ------------------------------------------------------------------ inner

  private async attestInner(wallet: Address, requestId: string): Promise<AttestResult> {
    let ev = await this.evaluateInner(wallet, false)
    if (ev.state !== 'SCORED') {
      await this.logRefusal(ev, wallet, requestId, 'attest')
      return ev
    }

    // A score with this exact data time may already be on-chain.
    const onChain = await this.d.registry.onChainScore(wallet)
    if (onChain.issuedAt >= ev.issuedAt) {
      if (!onChain.isStale) {
        return { ...ev, attestation: null, signature: null, reusedReservation: false, alreadyOnChain: true }
      }
      // On-chain copy is stale (expired, rotated key, or liquidated): the
      // registry would reject this data time as not newer. Fetch fresh data.
      ev = await this.evaluateInner(wallet, true)
      if (ev.state !== 'SCORED') {
        await this.logRefusal(ev, wallet, requestId, 'attest')
        return ev
      }
    }

    const nowSec = Math.floor(this.now() / 1000)
    if (ev.expiresAt - nowSec < 60) {
      // Cached data about to expire: a payload built on it could not be submitted in time.
      ev = await this.evaluateInner(wallet, true)
      if (ev.state !== 'SCORED') {
        await this.logRefusal(ev, wallet, requestId, 'attest')
        return ev
      }
    }
    const nonce = await this.d.registry.nonce(wallet)
    const candidate: Attestation = {
      wallet,
      score: ev.tenorScore,
      issuedAt: BigInt(ev.issuedAt),
      expiresAt: BigInt(ev.expiresAt),
      deadline: BigInt(Math.min(nowSec + this.d.submitWindowSeconds, ev.expiresAt - 1)),
      nonce,
      modelVersion: modelVersionHash(ev.modelVersion),
    }
    const before = await this.d.registry.liquidationRecord(wallet)
    const { payload, reused } = await this.d.store.reserve(wallet, nonce, candidate, this.now(), before.lastLiquidatedAt)

    // Best-effort re-check immediately before signing. A liquidation can still
    // land between here and submission; the registry is the authority then.
    const rec = await this.d.registry.liquidationRecord(wallet)
    if (rec.lastLiquidatedAt >= Number(payload.issuedAt)) {
      await this.d.store.deleteChainScores(wallet)
      const refusal: Evaluation = {
        state: 'UNAVAILABLE',
        reason: 'A Tenor liquidation was recorded after this score was computed. Request again for a fresh, adjusted score.',
        chains: [],
      }
      await this.logRefusal(refusal, wallet, requestId, 'attest')
      return refusal
    }

    const signature = await this.d.signer.sign(payload)
    this.d.log.info('attestation_signed', {
      requestId,
      wallet,
      nonce: payload.nonce.toString(),
      tenorScore: payload.score,
      reusedReservation: reused,
      signaturePrefix: signature.slice(0, 10),
    })
    return {
      ...ev,
      // If a reservation was reused, report exactly what was signed.
      tenorScore: payload.score,
      tier: scoreToTier(payload.score),
      issuedAt: Number(payload.issuedAt),
      expiresAt: Number(payload.expiresAt),
      attestation: serialize(payload),
      signature,
      reusedReservation: reused,
      alreadyOnChain: false,
    }
  }

  private async evaluateInner(wallet: Address, bypassCache: boolean): Promise<Evaluation> {
    const nowMs = this.now()
    const history = await this.historyFor(wallet, nowMs, bypassCache)
    const summary = summarize(history)

    // Nothing could be checked independently anywhere: no basis for a score.
    if (COVERED_CHAINS.every((c) => !history[c.slug].ok)) {
      return {
        state: 'UNAVAILABLE',
        reason: 'History verification unavailable: neither HyperSync nor the Alchemy fallback answered. Not a low score; try again.',
        chains: COVERED_CHAINS.map((c) => {
          const h = history[c.slug]
          return { chain: c.slug, name: c.name, reason: h.ok ? 'checked' : `history check failed: ${h.error}` }
        }),
        history: summary,
      }
    }

    const excluded: ChainNote[] = []
    const failures: ChainNote[] = []
    // Chains ChainScore must score, and how each was verified.
    const toScore: Array<{ slug: ChainSlug; aave: number; compound: number; verifiedBy: ContributingChain['verifiedBy'] }> = []

    for (const c of COVERED_CHAINS) {
      const h = history[c.slug]
      const borrows = h.ok ? h.aaveBorrows + h.compoundBorrows : 0
      if (h.ok && borrows > 0) {
        if (!c.chainscoreScoreable) {
          failures.push({
            chain: c.slug,
            name: c.name,
            reason: `${c.name}: ${borrows} borrow(s) found on-chain, but ChainScore does not score ${c.name} (it answers ${c.name} requests with Ethereum data; ChainScore issue #21)`,
          })
          continue
        }
        toScore.push({ slug: c.slug, aave: h.aaveBorrows, compound: h.compoundBorrows, verifiedBy: h.source })
        continue
      }
      if (h.ok && h.unverified.length === 0) {
        excluded.push({ chain: c.slug, name: c.name, reason: `no Aave or Compound borrowing found on-chain (${h.source})` })
        continue
      }
      // Partial verification: this chain (or one protocol on it) could not be
      // checked independently. Fall back to ChainScore's own view of it, which
      // can only lower the minimum, never hide a chain from it.
      const gap = h.ok ? `${h.unverified.join(', ')} not checkable by ${h.source}` : 'independent history check unavailable'
      if (!c.chainscoreScoreable) {
        excluded.push({ chain: c.slug, name: c.name, reason: `unverified: ${gap}, and ChainScore does not score ${c.name}` })
        continue
      }
      toScore.push({ slug: c.slug, aave: 0, compound: 0, verifiedBy: 'chainscore-only' })
    }

    if (failures.length === 0 && toScore.length === 0) {
      return {
        state: 'INSUFFICIENT_HISTORY',
        reason:
          'No Aave V2/V3 or Compound V2 borrowing found on any covered chain. Tenor lends to this wallet at floor terms. (Compound borrows made through a contract wallet are not detected.)',
        excludedChains: excluded,
        history: summary,
      }
    }

    if (bypassCache) await this.d.store.deleteChainScores(wallet)
    const counted: ContributingChain[] = []
    const computedTimes: number[] = []
    const versions = new Set<string>()

    for (const t of toScore) {
      const chain = chainBySlug(t.slug)
      const unverified = t.verifiedBy === 'chainscore-only'
      let cached = await this.d.store.getChainScore(wallet, t.slug, nowMs)
      if (!cached) {
        const upstream = await this.d.chainscore.score(wallet, t.slug)
        if (unverified && upstream.ok && !seesBorrowing(upstream.data)) {
          excluded.push({ chain: t.slug, name: chain.name, reason: 'unverified: independent check unavailable; ChainScore reports no borrowing here' })
          continue
        }
        const v = validateChain(chain, unverified ? null : t.aave + t.compound, upstream, nowMs)
        if (!v.counted) {
          failures.push({ chain: t.slug, name: chain.name, reason: v.reason })
          continue
        }
        cached = { score: v.score, computedAtMs: v.computedAtMs, modelVersion: v.modelVersion }
        await this.d.store.putChainScore(wallet, t.slug, cached, v.computedAtMs + this.d.scoreTtlSeconds * 1000)
      }
      counted.push({ chain: t.slug, name: chain.name, chainscoreScore: cached.score, aaveBorrows: t.aave, compoundBorrows: t.compound, verifiedBy: t.verifiedBy })
      computedTimes.push(cached.computedAtMs)
      versions.add(cached.modelVersion ?? 'unknown')
    }

    if (failures.length > 0) {
      failures.sort((a, b) => a.chain.localeCompare(b.chain))
      return {
        state: 'UNAVAILABLE',
        reason: `${failures.map((f) => f.reason).join('; ')}. Cannot score without every chain this wallet borrowed on. Not a low score.`,
        chains: failures,
        history: summary,
      }
    }
    if (!counted.some((c) => c.verifiedBy !== 'chainscore-only')) {
      // Every contributing chain came from ChainScore alone: no independent
      // evidence of borrowing at all.
      if (counted.length === 0) {
        return {
          state: 'INSUFFICIENT_HISTORY',
          reason: 'No borrowing found by the independent check, and ChainScore reports none on the chains that could not be checked.',
          excludedChains: excluded,
          history: summary,
        }
      }
      return {
        state: 'UNAVAILABLE',
        reason: 'History verification unavailable: borrowing is reported only by ChainScore and could not be confirmed independently on any chain. Not a low score.',
        chains: counted.map((c) => ({ chain: c.chain, name: c.name, reason: 'reported by ChainScore only; independent check unavailable' })),
        history: summary,
      }
    }

    counted.sort((a, b) => a.chain.localeCompare(b.chain))
    const chainscoreScore = this.aggregation.combine(counted.map((c) => ({ chain: c.chain, score: c.chainscoreScore })))
    // The oldest contributing computation is the data time of the whole score.
    const issuedAt = Math.floor(Math.min(...computedTimes) / 1000)

    const rec = await this.d.registry.liquidationRecord(wallet)
    if (rec.lastLiquidatedAt >= issuedAt) {
      // Data predates the wallet's latest Tenor liquidation: the registry
      // would reject it. Fetch data computed after the liquidation, once.
      if (!bypassCache) return this.evaluateInner(wallet, true)
      return {
        state: 'UNAVAILABLE',
        reason: "ChainScore's data predates this wallet's latest Tenor liquidation; try again shortly.",
        chains: [],
        history: summary,
      }
    }

    const nowSec = Math.floor(nowMs / 1000)
    const policy = applyTenorPolicy(chainscoreScore, rec, nowSec)
    return {
      state: 'SCORED',
      chainscoreScore,
      aggregation: { rule: this.aggregation.name, description: this.aggregation.description },
      adjustments: policy.adjustments,
      policyCaps: policy.policyCaps,
      tenorScore: policy.tenorScore,
      tier: scoreToTier(policy.tenorScore),
      issuedAt,
      expiresAt: issuedAt + this.d.scoreTtlSeconds,
      modelVersion: [...versions].sort().join('+'),
      contributingChains: counted,
      excludedChains: excluded,
      history: summary,
    }
  }

  /** History results are cached for the score TTL (only when every chain was
   *  checked, so a partial result is retried next time). */
  private async historyFor(wallet: Address, nowMs: number, bypass: boolean) {
    if (!bypass) {
      const hit = await this.d.store.getHistory(wallet, nowMs)
      if (hit) return hit
    }
    const h = await this.d.history.check(wallet)
    if (COVERED_CHAINS.every((c) => h[c.slug].ok)) {
      await this.d.store.putHistory(wallet, h, nowMs + this.d.scoreTtlSeconds * 1000)
    }
    return h
  }

  private async logRefusal(ev: Exclude<Evaluation, { state: 'SCORED' }>, wallet: Address, requestId: string, endpoint: string) {
    const chains = ev.state === 'UNAVAILABLE' ? ev.chains : ev.excludedChains
    await this.d.store.logRefusal({
      at: new Date(this.now()).toISOString(),
      requestId,
      endpoint,
      wallet,
      state: ev.state,
      reason: ev.reason,
      chains: chains.map((c) => ({ chain: c.chain, reason: c.reason })),
    })
    this.d.log.info('refusal', { requestId, endpoint, wallet, state: ev.state, reason: ev.reason })
  }

  private async withWalletLock<T>(wallet: Address, fn: () => Promise<T>): Promise<T> {
    const key = wallet.toLowerCase()
    const prev = this.locks.get(key) ?? Promise.resolve()
    const run = prev.then(fn, fn)
    const tail = run.catch(() => undefined)
    this.locks.set(key, tail)
    try {
      return await run
    } finally {
      if (this.locks.get(key) === tail) this.locks.delete(key)
    }
  }
}

function summarize(history: Record<ChainSlug, ChainHistory>): HistorySummary {
  const sources = COVERED_CHAINS.map((c) => {
    const h = history[c.slug]
    return h.ok
      ? { chain: c.slug, name: c.name, source: h.source, unverified: [...h.unverified], ...(h.primaryError ? { primaryError: h.primaryError } : {}) }
      : { chain: c.slug, name: c.name, source: null, unverified: ['all'], primaryError: h.error }
  })
  return { verification: sources.every((s) => s.source && s.unverified.length === 0) ? 'full' : 'partial', sources }
}

/** ChainScore's own view that the wallet borrowed on this chain. */
function seesBorrowing(d: { protocolsUsed: string[]; newWallet: boolean; noBorrowHistory?: boolean }) {
  return !d.newWallet && !d.noBorrowHistory && (d.protocolsUsed.includes('Aave') || d.protocolsUsed.includes('Compound'))
}

function serialize(a: Attestation): SerializedAttestation {
  return {
    wallet: a.wallet,
    score: a.score,
    issuedAt: a.issuedAt.toString(),
    expiresAt: a.expiresAt.toString(),
    deadline: a.deadline.toString(),
    nonce: a.nonce.toString(),
    modelVersion: a.modelVersion,
  }
}
