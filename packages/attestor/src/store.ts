/**
 * Shared state the service needs: the score cache, per-(wallet, nonce) payload
 * reservations, rate limits, and the refusal log. Behind an interface so a
 * Postgres implementation can replace the in-memory one for a multi-instance
 * deployment; the in-memory store is correct only for a single process.
 *
 * Signatures are never stored. Reservations store the PAYLOAD; re-signing an
 * identical payload yields an identical signature (deterministic ECDSA), so
 * a repeated request cannot produce a second, different attestation for the
 * same nonce.
 */
import type { Address } from 'viem'
import type { ChainSlug } from './coverage.js'
import type { Attestation } from './signer.js'

export interface CachedChainScore {
  score: number
  computedAtMs: number
  modelVersion: string | undefined
}

export interface RefusalEntry {
  at: string
  requestId: string
  endpoint: string
  wallet: Address
  state: 'INSUFFICIENT_HISTORY' | 'UNAVAILABLE'
  reason: string
  chains?: Array<{ chain: ChainSlug; reason: string }>
}

export interface Store {
  getChainScore(wallet: Address, chain: ChainSlug, nowMs: number): Promise<CachedChainScore | undefined>
  putChainScore(wallet: Address, chain: ChainSlug, value: CachedChainScore, expiresAtMs: number): Promise<void>
  deleteChainScores(wallet: Address): Promise<void>
  /** Atomically returns the live reservation for (wallet, nonce), or stores
   *  `payload` as the reservation if none is live. A reservation is live if its
   *  deadline has not passed AND its issuedAt is after `lastLiquidatedAt`:
   *  one issued before a Tenor liquidation can never be accepted on-chain, so
   *  replacing it does not give the wallet a choice between two payloads. */
  reserve(
    wallet: Address,
    nonce: bigint,
    payload: Attestation,
    nowMs: number,
    lastLiquidatedAt: number,
  ): Promise<{ payload: Attestation; reused: boolean }>
  /** True if the key is under its limit (and counts this hit). */
  hit(key: string, max: number, windowMs: number, nowMs: number): Promise<boolean>
  logRefusal(entry: RefusalEntry): Promise<void>
  listRefusals(limit: number): Promise<RefusalEntry[]>
}

export class MemoryStore implements Store {
  private scores = new Map<string, { value: CachedChainScore; expiresAtMs: number }>()
  private reservations = new Map<string, Attestation>()
  private hits = new Map<string, number[]>()
  private refusals: RefusalEntry[] = []

  async getChainScore(wallet: Address, chain: ChainSlug, nowMs: number) {
    const e = this.scores.get(`${wallet.toLowerCase()}:${chain}`)
    if (!e || e.expiresAtMs <= nowMs) return undefined
    return e.value
  }

  async putChainScore(wallet: Address, chain: ChainSlug, value: CachedChainScore, expiresAtMs: number) {
    this.scores.set(`${wallet.toLowerCase()}:${chain}`, { value, expiresAtMs })
  }

  async deleteChainScores(wallet: Address) {
    const prefix = `${wallet.toLowerCase()}:`
    for (const k of [...this.scores.keys()]) if (k.startsWith(prefix)) this.scores.delete(k)
  }

  // JavaScript runs this method to completion without interleaving, so the
  // check-then-set is atomic within one process.
  async reserve(wallet: Address, nonce: bigint, payload: Attestation, nowMs: number, lastLiquidatedAt: number) {
    const key = `${wallet.toLowerCase()}:${nonce}`
    const existing = this.reservations.get(key)
    const live = existing && Number(existing.deadline) * 1000 > nowMs && Number(existing.issuedAt) > lastLiquidatedAt
    if (existing && live) return { payload: existing, reused: true }
    this.reservations.set(key, payload)
    return { payload, reused: false }
  }

  async hit(key: string, max: number, windowMs: number, nowMs: number) {
    const recent = (this.hits.get(key) ?? []).filter((t) => t > nowMs - windowMs)
    if (recent.length >= max) {
      this.hits.set(key, recent)
      return false
    }
    recent.push(nowMs)
    this.hits.set(key, recent)
    return true
  }

  async logRefusal(entry: RefusalEntry) {
    this.refusals.push(entry)
    if (this.refusals.length > 1000) this.refusals.shift()
  }

  async listRefusals(limit: number) {
    return this.refusals.slice(-limit).reverse()
  }
}
