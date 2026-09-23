import { describe, expect, it } from 'vitest'
import { HyperSyncHistoryChecker } from '../src/history.js'
import { LegacyChainScoreClient } from '../src/chainscore.js'
import { createApp } from '../src/http.js'
import { MemoryStore } from '../src/store.js'
import { silentLogger } from '../src/log.js'
import { WALLET, makeService } from './fakes.js'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('HyperSyncHistoryChecker', () => {
  it('pages to the head as of the first response, counting logs and Compound transactions separately', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body))
      bodies.push({ url, ...body })
      const isTx = Array.isArray(body.transactions)
      // Page 1 stops at 500; page 2 reaches the target; the head keeps moving.
      if (body.from_block === 0) {
        return json({ data: [{ [isTx ? 'transactions' : 'logs']: [{}, {}] }], next_block: 500, archive_height: 1000 })
      }
      return json({ data: [{ [isTx ? 'transactions' : 'logs']: [{}] }], next_block: 1000, archive_height: 1010 })
    }) as unknown as typeof fetch
    const res = await new HyperSyncHistoryChecker({ apiToken: 't', fetchImpl }).check(WALLET)
    expect(res.ethereum).toEqual({ ok: true, aaveBorrows: 3, compoundBorrows: 3 })
    expect(res.arbitrum).toEqual({ ok: true, aaveBorrows: 3, compoundBorrows: 0 })
    // Ethereum queries Aave V3 + V2 pools in one log query, Compound in a separate transaction query.
    const ethLog = bodies.find((b) => String(b.url).startsWith('https://1.hypersync.xyz') && b.logs) as { logs: unknown[] }
    expect(ethLog.logs).toHaveLength(2)
    expect(bodies.some((b) => String(b.url).startsWith('https://1.hypersync.xyz') && b.transactions)).toBe(true)
    expect(bodies.some((b) => String(b.url).startsWith('https://42161.hypersync.xyz') && b.transactions)).toBe(false)
  })

  it('HTTP errors and malformed bodies become per-chain errors, never zero borrows', async () => {
    let n = 0
    const fetchImpl = (async () => (n++ % 2 === 0 ? json({}, 502) : json({ unexpected: true }))) as unknown as typeof fetch
    const res = await new HyperSyncHistoryChecker({ apiToken: 't', fetchImpl }).check(WALLET)
    for (const r of Object.values(res)) expect(r.ok).toBe(false)
  })

  it('a transport failure (e.g. TLS rejection) is an error, not "no history"', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    const res = await new HyperSyncHistoryChecker({ apiToken: 't', fetchImpl }).check(WALLET)
    expect(res.base).toEqual({ ok: false, error: 'fetch failed' })
  })

  it('pagination that stops advancing is an error', async () => {
    const fetchImpl = (async () => json({ data: [], next_block: 0, archive_height: 10 })) as unknown as typeof fetch
    const res = await new HyperSyncHistoryChecker({ apiToken: 't', fetchImpl }).check(WALLET)
    expect(res.polygon.ok).toBe(false)
  })
})

describe('LegacyChainScoreClient (untrusted input)', () => {
  const valid = { score: 790, newWallet: false, walletAge: 10, totalTxns: 5, protocolsUsed: ['Aave'], degradedSources: [], timestamp: 1, extra: 'ignored' }

  it('parses a valid response and ignores unknown fields', async () => {
    const c = new LegacyChainScoreClient('https://x', (async () => json(valid)) as unknown as typeof fetch)
    const r = await c.score(WALLET, 'arbitrum')
    expect(r).toMatchObject({ ok: true, data: { score: 790 } })
  })

  it('rejects responses missing required fields', async () => {
    const { totalTxns: _, ...missing } = valid
    const c = new LegacyChainScoreClient('https://x', (async () => json(missing)) as unknown as typeof fetch)
    expect(await c.score(WALLET, 'arbitrum')).toEqual({ ok: false, error: 'ChainScore response failed schema validation' })
  })

  it('maps unreachable, rate-limited and HTTP errors', async () => {
    const down = new LegacyChainScoreClient('http://127.0.0.1:9', (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch)
    expect((await down.score(WALLET, 'base')).ok).toBe(false)
    const limited = new LegacyChainScoreClient('https://x', (async () => json({}, 429)) as unknown as typeof fetch)
    expect(await limited.score(WALLET, 'base')).toEqual({ ok: false, error: 'ChainScore rate limit reached' })
  })
})

describe('HTTP adapter', () => {
  const app = (limits = { ip: 30, addr: 6 }) => {
    const t = makeService()
    const store = new MemoryStore()
    return createApp({
      service: t.service,
      store,
      log: silentLogger,
      health: [{ name: 'fake', check: async () => ({ ok: false, detail: 'down' }) }],
      rateLimitPerIp: limits.ip,
      rateLimitPerAddress: limits.addr,
    })
  }

  it('rejects a malformed address with 400', async () => {
    const res = await app().request('/attest', { method: 'POST', body: JSON.stringify({ address: '0x123' }) })
    expect(res.status).toBe(400)
  })

  it('returns the typed refusal with a request id', async () => {
    const res = await app().request('/attest', {
      method: 'POST',
      headers: { 'x-request-id': 'abc' },
      body: JSON.stringify({ address: WALLET.toLowerCase() }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ requestId: 'abc', state: 'INSUFFICIENT_HISTORY' })
  })

  it('rate limits per address', async () => {
    const a = app({ ip: 100, addr: 2 })
    const call = () => a.request(`/score/${WALLET}`)
    expect((await call()).status).toBe(200)
    expect((await call()).status).toBe(200)
    expect((await call()).status).toBe(429)
  })

  it('health reports each dependency and 503 when any is down', async () => {
    const res = await app().request('/health')
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ ok: false, dependencies: [{ name: 'fake', ok: false, detail: 'down' }] })
  })
})
