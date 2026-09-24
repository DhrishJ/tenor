/**
 * One contract, two stores. The Postgres half runs only when
 * TEST_DATABASE_URL is set (a throwaway local database; see README).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Address, Hex } from 'viem'
import { MemoryStore, type Store } from '../src/store.js'
import { PgStore } from '../src/pgStore.js'
import type { Attestation } from '../src/signer.js'

const W = '0x00000000000000000000000000000000000000a1' as Address
const att = (issuedAt: number, deadline: number, score = 700): Attestation => ({
  wallet: W,
  score,
  issuedAt: BigInt(issuedAt),
  expiresAt: BigInt(issuedAt + 86_400),
  deadline: BigInt(deadline),
  nonce: 0n,
  modelVersion: ('0x' + '11'.repeat(32)) as Hex,
})

function contract(name: string, make: () => Promise<Store>) {
  describe(name, () => {
    let s: Store
    beforeAll(async () => {
      s = await make()
    })

    it('reuses a live reservation and returns the identical payload', async () => {
      const a = await s.reserve(W, 0n, att(1000, 2000), 1_500_000, 0)
      const b = await s.reserve(W, 0n, att(1001, 2001, 800), 1_500_000, 0)
      expect(a.reused).toBe(false)
      expect(b.reused).toBe(true)
      expect(b.payload).toEqual(a.payload)
    })

    it('replaces a reservation issued before a Tenor liquidation', async () => {
      const r = await s.reserve(W, 0n, att(1500, 2500, 628), 1_600_000, 1200)
      expect(r.reused).toBe(false)
      expect(r.payload.score).toBe(628)
    })

    it('replaces an expired reservation', async () => {
      const r = await s.reserve(W, 0n, att(3000, 4000, 640), 3_000_000, 1200)
      expect(r.reused).toBe(false)
      expect(r.payload.issuedAt).toBe(3000n)
    })

    it('counts rate-limit hits', async () => {
      const k = `t:${name}:${Math.random()}`
      expect(await s.hit(k, 2, 60_000, 120_000)).toBe(true)
      expect(await s.hit(k, 2, 60_000, 120_001)).toBe(true)
      expect(await s.hit(k, 2, 60_000, 120_002)).toBe(false)
    })

    it('caches and expires chain scores', async () => {
      await s.putChainScore(W, 'ethereum', { score: 700, computedAtMs: 1, modelVersion: 'v' }, 10_000)
      expect((await s.getChainScore(W, 'ethereum', 9_999))?.score).toBe(700)
      expect(await s.getChainScore(W, 'ethereum', 10_000)).toBeUndefined()
      await s.deleteChainScores(W)
      expect(await s.getChainScore(W, 'ethereum', 1)).toBeUndefined()
    })

    it('stores refusals newest first, and meta', async () => {
      const e = (id: string) => ({ at: 'x', requestId: id, endpoint: 'score', wallet: W, state: 'UNAVAILABLE' as const, reason: 'r' })
      await s.logRefusal(e(`${name}-1`))
      await s.logRefusal(e(`${name}-2`))
      const l = await s.listRefusals(2)
      expect(l.map((x) => x.requestId)).toEqual([`${name}-2`, `${name}-1`])
      await s.setMeta('k', 'v1')
      await s.setMeta('k', 'v2')
      expect(await s.getMeta('k')).toBe('v2')
    })
  })
}

contract('MemoryStore', async () => new MemoryStore())

const url = process.env.TEST_DATABASE_URL
describe.skipIf(!url)('PgStore', () => {
  const stores: PgStore[] = []
  const fresh = async () => {
    const s = new PgStore({ connectionString: url! })
    stores.push(s)
    await s.migrate()
    return s
  }
  beforeAll(async () => {
    const s = await fresh()
    await s.pool.query(
      'truncate tenor_chain_scores, tenor_histories, tenor_reservations, tenor_rate_hits, tenor_refusals, tenor_meta',
    )
  })
  afterAll(async () => {
    await Promise.all(stores.map((s) => s.close()))
  })

  contract('PgStore contract', fresh)

  it('a restart keeps nonce reservations (§5)', async () => {
    const V = '0x00000000000000000000000000000000000000b2' as Address
    const first = await fresh()
    const a = await first.reserve(V, 7n, { ...att(5000, 9000), wallet: V, nonce: 7n }, 6_000_000, 0)
    await first.close()
    stores.splice(stores.indexOf(first), 1)
    const second = await fresh()
    const b = await second.reserve(V, 7n, { ...att(5001, 9001, 820), wallet: V, nonce: 7n }, 6_000_000, 0)
    expect(b.reused).toBe(true)
    expect(b.payload).toEqual(a.payload)
  })

  it('concurrent reservations for one nonce agree on a single payload', async () => {
    const V = '0x00000000000000000000000000000000000000c3' as Address
    const a = await fresh()
    const b = await fresh()
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        (i % 2 ? a : b).reserve(V, 1n, { ...att(7000 + i, 9999, 600 + i), wallet: V, nonce: 1n }, 7_000_000, 0),
      ),
    )
    expect(new Set(results.map((r) => r.payload.score)).size).toBe(1)
    expect(results.filter((r) => !r.reused)).toHaveLength(1)
  })
})
