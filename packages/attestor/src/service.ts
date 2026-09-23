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
import type { HistoryChecker } from './history.js'
import { applyTenorPolicy, type Adjustment } from './policy.js'
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
}

export type Evaluation =
  | {
      state: 'SCORED'
      /** What ChainScore returned, combined across chains by `aggregation`. */
      chainscoreScore: number
      aggregation: { rule: string; description: string }
      /** Tenor policy adjustments, itemized. Not ChainScore's. */
      adjustments: Adjustment[]
      /** chainscoreScore + adjustments: the number that is signed. */
      tenorScore: number
      tier: Tier
      /** When ChainScore computed the data (unix seconds), not signing time. */
      issuedAt: number
      expiresAt: number
      modelVersion: string
      contributingChains: ContributingChain[]
      excludedChains: ChainNote[]
    }
  | { state: 'INSUFFICIENT_HISTORY'; reason: string; excludedChains: ChainNote[] }
  | { state: 'UNAVAILABLE'; reason: string; chains: ChainNote[] }

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
    const history = await this.d.history.check(wallet)

    // Our own independent check failed: we cannot know which chains matter.
    const historyFailures: ChainNote[] = []
    for (const c of COVERED_CHAINS) {
      const h = history[c.slug]
      if (!h.ok) historyFailures.push({ chain: c.slug, name: c.name, reason: `independent history check failed: ${h.error}` })
    }
    if (historyFailures.length > 0) {
      return {
        state: 'UNAVAILABLE',
        reason: `Could not verify borrowing history on ${historyFailures.map((c) => c.name).join(', ')}. Not a low score; try again.`,
        chains: historyFailures,
      }
    }

    const excluded: ChainNote[] = []
    const borrowed: Array<{ slug: ChainSlug; aave: number; compound: number }> = []
    for (const c of COVERED_CHAINS) {
      const h = history[c.slug]
      if (!h.ok) continue
      if (h.aaveBorrows + h.compoundBorrows > 0) borrowed.push({ slug: c.slug, aave: h.aaveBorrows, compound: h.compoundBorrows })
      else excluded.push({ chain: c.slug, name: c.name, reason: 'no Aave or Compound borrowing found on-chain' })
    }
    if (borrowed.length === 0) {
      return {
        state: 'INSUFFICIENT_HISTORY',
        reason:
          'No Aave V2/V3 or Compound V2 borrowing found on any covered chain. Tenor lends to this wallet at floor terms. (Compound borrows made through a contract wallet are not detected.)',
        excludedChains: excluded,
      }
    }

    if (bypassCache) await this.d.store.deleteChainScores(wallet)
    const counted: ContributingChain[] = []
    const computedTimes: number[] = []
    const versions = new Set<string>()
    const failures: ChainNote[] = []

    await Promise.all(
      borrowed.map(async (b) => {
        const chain = chainBySlug(b.slug)
        let cached = await this.d.store.getChainScore(wallet, b.slug, nowMs)
        if (!cached) {
          const upstream = await this.d.chainscore.score(wallet, b.slug)
          const h = history[b.slug]
          if (!h.ok) return
          const v = validateChain(chain, h, upstream, nowMs)
          if (!v.counted) {
            failures.push({ chain: b.slug, name: chain.name, reason: v.reason })
            return
          }
          cached = { score: v.score, computedAtMs: v.computedAtMs, modelVersion: v.modelVersion }
          await this.d.store.putChainScore(wallet, b.slug, cached, v.computedAtMs + this.d.scoreTtlSeconds * 1000)
        }
        counted.push({ chain: b.slug, name: chain.name, chainscoreScore: cached.score, aaveBorrows: b.aave, compoundBorrows: b.compound })
        computedTimes.push(cached.computedAtMs)
        versions.add(cached.modelVersion ?? 'unknown')
      }),
    )

    if (failures.length > 0) {
      failures.sort((a, b) => a.chain.localeCompare(b.chain))
      return {
        state: 'UNAVAILABLE',
        reason: `${failures.map((f) => f.reason).join('; ')}. Cannot score without every chain this wallet borrowed on. Not a low score.`,
        chains: failures,
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
      }
    }

    const nowSec = Math.floor(nowMs / 1000)
    const policy = applyTenorPolicy(chainscoreScore, rec, nowSec)
    return {
      state: 'SCORED',
      chainscoreScore,
      aggregation: { rule: this.aggregation.name, description: this.aggregation.description },
      adjustments: policy.adjustments,
      tenorScore: policy.tenorScore,
      tier: scoreToTier(policy.tenorScore),
      issuedAt,
      expiresAt: issuedAt + this.d.scoreTtlSeconds,
      modelVersion: [...versions].sort().join('+'),
      contributingChains: counted,
      excludedChains: excluded,
    }
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
