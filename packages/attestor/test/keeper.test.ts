import { describe, expect, it } from 'vitest'
import type { Address, PublicClient } from 'viem'
import { Keeper, indexerPingStep, oracleFreshnessCheck } from '../src/keeper.js'
import { MemoryStore } from '../src/store.js'
import { silentLogger, type Logger } from '../src/log.js'

const H = 3_600_000
const DAY = 24 * H

describe('Keeper', () => {
  it('reports DEGRADED when it has never run', async () => {
    const k = new Keeper({ steps: [], store: new MemoryStore(), log: silentLogger, intervalMs: DAY })
    const h = await k.health().check()
    expect(h.ok).toBe(false)
    expect(h.detail).toMatch(/^DEGRADED: keeper has never run/)
  })

  it('records each step, and a fresh successful run is healthy', async () => {
    let t = 1_000 * DAY
    const k = new Keeper({
      steps: [{ name: 'a', run: async () => 'did a' }],
      store: new MemoryStore(),
      log: silentLogger,
      intervalMs: DAY,
      now: () => t,
    })
    const run = await k.runOnce()
    expect(run.ok).toBe(true)
    expect(run.steps).toEqual([{ name: 'a', ok: true, detail: 'did a' }])
    t += DAY
    expect((await k.health().check()).ok).toBe(true)
  })

  it('reports DEGRADED, not an old timestamp, once overdue (P4-O13)', async () => {
    let t = 1_000 * DAY
    const k = new Keeper({ steps: [{ name: 'a', run: async () => 'ok' }], store: new MemoryStore(), log: silentLogger, intervalMs: DAY, now: () => t })
    await k.runOnce()
    t += DAY + 2 * H
    const h = await k.health().check()
    expect(h.ok).toBe(false)
    expect(h.detail).toMatch(/^DEGRADED: last run .* is overdue \(26 h ago\)/)
  })

  it('a failing step fails the run, keeps the other steps, and reports DEGRADED', async () => {
    const k = new Keeper({
      steps: [
        { name: 'restamp', run: async () => { throw new Error('keeper 0xabc is not the oracle owner (0xdef)\nstack') } },
        { name: 'ping', run: async () => 'indexer answered' },
      ],
      store: new MemoryStore(),
      log: silentLogger,
      intervalMs: DAY,
    })
    const run = await k.runOnce()
    expect(run.ok).toBe(false)
    expect(run.steps[0]).toEqual({ name: 'restamp', ok: false, detail: 'keeper 0xabc is not the oracle owner (0xdef)' })
    expect(run.steps[1]!.ok).toBe(true)
    expect((await k.health().check()).detail).toMatch(/^DEGRADED: last run .* failed\. restamp FAILED/)
  })

  it('after a restart, waits out the interval if the last run succeeded recently', async () => {
    const store = new MemoryStore()
    let t = 1_000 * DAY
    const first = new Keeper({ steps: [], store, log: silentLogger, intervalMs: DAY, now: () => t })
    await first.runOnce()
    t += 5 * H
    const logged: Array<Record<string, unknown> | undefined> = []
    const log: Logger = { info: (_e, f) => logged.push(f), error: () => {} }
    const second = new Keeper({ steps: [], store, log, intervalMs: DAY, now: () => t })
    await second.start()
    second.stop()
    expect(logged[0]).toEqual({ firstRunInMs: 19 * H, intervalMs: DAY })
  })
})

describe('oracleFreshnessCheck', () => {
  const oracle = '0x0000000000000000000000000000000000000001' as Address
  const asset = '0x0000000000000000000000000000000000000002' as Address
  const check = (ageSec: number) =>
    oracleFreshnessCheck({
      client: { readContract: async () => [10n ** 18n, BigInt(1_000_000 - ageSec)] } as unknown as PublicClient,
      oracle,
      assets: [{ symbol: 'tCOLL', address: asset }],
      maxPriceAgeSec: 7 * 86_400,
      keeperIntervalMs: DAY,
      now: () => 1_000_000_000,
    }).check()

  it('is healthy inside the keeper window', async () => {
    expect(await check(3_600)).toEqual({ ok: true, detail: 'tCOLL 60 min old (max age 168 h)' })
  })
  it('is DEGRADED once the keeper should have re-stamped', async () => {
    const r = await check(30 * 3_600)
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/tCOLL DEGRADED: 30 h old/)
  })
  it('says borrowing stops once the price is stale', async () => {
    const r = await check(8 * 86_400)
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/tCOLL STALE \(192 h\): borrowing and liquidation revert/)
  })
})

describe('indexerPingStep', () => {
  it('fails on a GraphQL error even with HTTP 200', async () => {
    const f = (async () => new Response(JSON.stringify({ errors: [{ message: 'nope' }] }), { status: 200 })) as typeof fetch
    await expect(indexerPingStep('http://x', f).run()).rejects.toThrow(/indexer HTTP 200: .*nope/)
  })
  it('passes when data comes back', async () => {
    const f = (async () => new Response(JSON.stringify({ data: { MarketTotals: [{ id: 'market' }] } }))) as typeof fetch
    expect(await indexerPingStep('http://x', f).run()).toBe('indexer answered (MarketTotals rows: 1)')
  })
})
