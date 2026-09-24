import { describe, expect, it } from 'vitest'
import { AlchemyHistorySource, FallbackHistoryChecker, HyperSyncHistoryChecker } from '../src/history.js'
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
    const res = await new HyperSyncHistoryChecker({ apiToken: 't', fetchImpl, minIntervalMs: 0 }).check(WALLET)
    expect(res.ethereum).toEqual({ ok: true, aaveBorrows: 3, compoundBorrows: 3, source: 'hypersync', unverified: [] })
    expect(res.arbitrum).toEqual({ ok: true, aaveBorrows: 3, compoundBorrows: 0, source: 'hypersync', unverified: [] })
    // Ethereum queries Aave V3 + V2 pools in one log query, Compound in a separate transaction query.
    const ethLog = bodies.find((b) => String(b.url).startsWith('https://1.hypersync.xyz') && b.logs) as { logs: unknown[] }
    expect(ethLog.logs).toHaveLength(2)
    expect(bodies.some((b) => String(b.url).startsWith('https://1.hypersync.xyz') && b.transactions)).toBe(true)
    expect(bodies.some((b) => String(b.url).startsWith('https://42161.hypersync.xyz') && b.transactions)).toBe(false)
  })

  it('HTTP errors and malformed bodies become per-chain errors, never zero borrows', async () => {
    let n = 0
    const fetchImpl = (async () => (n++ % 2 === 0 ? json({}, 502) : json({ unexpected: true }))) as unknown as typeof fetch
    const res = await new HyperSyncHistoryChecker({ apiToken: 't', fetchImpl, minIntervalMs: 0 }).check(WALLET)
    for (const r of Object.values(res)) expect(r.ok).toBe(false)
  })

  it('a transport failure (e.g. TLS rejection) is an error, not "no history"', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    const res = await new HyperSyncHistoryChecker({ apiToken: 't', fetchImpl, minIntervalMs: 0 }).check(WALLET)
    expect(res.base).toEqual({ ok: false, error: 'fetch failed', attempted: ['hypersync'] })
  })

  it('pagination that stops advancing is an error', async () => {
    const fetchImpl = (async () => json({ data: [], next_block: 0, archive_height: 10 })) as unknown as typeof fetch
    const res = await new HyperSyncHistoryChecker({ apiToken: 't', fetchImpl, minIntervalMs: 0 }).check(WALLET)
    expect(res.polygon.ok).toBe(false)
  })
})

describe('HyperSync 429 handling', () => {
  it('retries after a 429 and succeeds', async () => {
    let n = 0
    const fetchImpl = (async () => {
      n++
      if (n === 1) return new Response('', { status: 429, headers: { 'retry-after': '0.01' } })
      return json({ data: [], next_block: 10, archive_height: 10 })
    }) as unknown as typeof fetch
    const res = await new HyperSyncHistoryChecker({ apiToken: 't', fetchImpl, minIntervalMs: 0 }).check(WALLET)
    expect(res.arbitrum.ok).toBe(true)
  })

  it('gives up after bounded retries: an error, not "no history"', async () => {
    const fetchImpl = (async () => new Response('', { status: 429, headers: { 'retry-after': '0.001' } })) as unknown as typeof fetch
    const res = await new HyperSyncHistoryChecker({ apiToken: 't', fetchImpl, minIntervalMs: 0, max429Retries: 2 }).check(WALLET)
    expect(res.polygon).toMatchObject({ ok: false, error: 'HyperSync HTTP 429 on chain 137' })
  })
})

describe('AlchemyHistorySource (fallback) and FallbackHistoryChecker', () => {
  const alchemyFetch = (mintsByNetwork: Record<string, number>, pages = 1) =>
    (async (url: string, init: RequestInit) => {
      const network = new URL(url).hostname.split('.')[0]!
      const params = JSON.parse(String(init.body)).params[0]
      const n = mintsByNetwork[network] ?? 0
      const page = params.pageKey ? Number(params.pageKey) : 0
      const transfers = page < pages - 1 ? [{}] : Array.from({ length: Math.max(n - (pages - 1), 0) }, () => ({}))
      return json({ jsonrpc: '2.0', id: 1, result: { transfers, ...(page < pages - 1 ? { pageKey: String(page + 1) } : {}) } })
    }) as unknown as typeof fetch

  it('counts Aave debt-token mints, pages through results, and marks Compound unverified on Ethereum', async () => {
    const src = new AlchemyHistorySource({ apiKey: 'k', fetchImpl: alchemyFetch({ 'arb-mainnet': 3, 'eth-mainnet': 2 }, 2) })
    const res = await src.check(WALLET)
    expect(res.arbitrum).toEqual({ ok: true, aaveBorrows: 3, compoundBorrows: 0, source: 'alchemy', unverified: [] })
    expect(res.ethereum).toEqual({ ok: true, aaveBorrows: 2, compoundBorrows: 0, source: 'alchemy', unverified: ['compound'] })
  })

  it('does not cover Avalanche or Scroll (stated gap)', async () => {
    const res = await new AlchemyHistorySource({ apiKey: 'k', fetchImpl: alchemyFetch({}) }).check(WALLET)
    expect(res.avalanche).toMatchObject({ ok: false, error: 'Alchemy fallback does not cover Avalanche' })
    expect(res.scroll).toMatchObject({ ok: false, error: 'Alchemy fallback does not cover Scroll' })
  })

  it('queries only debt tokens, sent to the wallet', async () => {
    let body: { params: Array<{ toAddress: string; contractAddresses: string[]; category: string[] }> } | undefined
    const f = (async (_u: string, init: RequestInit) => {
      body = JSON.parse(String(init.body))
      return json({ result: { transfers: [] } })
    }) as unknown as typeof fetch
    const src = new AlchemyHistorySource({ apiKey: 'k', fetchImpl: f })
    await src.checkChain((await import('../src/coverage.js')).chainBySlug('base'), WALLET)
    expect(body?.params[0]?.toAddress).toBe(WALLET)
    expect(body?.params[0]?.category).toEqual(['erc20'])
    expect(body?.params[0]?.contractAddresses.length).toBe(15)
  })

  it('falls back per chain and records which source answered and why the primary failed', async () => {
    const deadPrimary = new HyperSyncHistoryChecker({
      apiToken: 't',
      minIntervalMs: 0,
      fetchImpl: (async () => {
        throw new TypeError('fetch failed')
      }) as unknown as typeof fetch,
    })
    const alchemy = new AlchemyHistorySource({ apiKey: 'k', fetchImpl: alchemyFetch({ 'arb-mainnet': 3 }) })
    const res = await new FallbackHistoryChecker(deadPrimary, alchemy).check(WALLET)
    expect(res.arbitrum).toEqual({ ok: true, aaveBorrows: 3, compoundBorrows: 0, source: 'alchemy', unverified: [], primaryError: 'fetch failed' })
    expect(res.scroll).toEqual({ ok: false, error: 'fetch failed; Alchemy fallback does not cover Scroll', attempted: ['hypersync', 'alchemy'] })
  })
})

describe('LegacyChainScoreClient (untrusted input)', () => {
  it('never sends a Scroll query (ChainScore answers Scroll with Ethereum data, issue #21)', async () => {
    let called = false
    const c = new LegacyChainScoreClient('https://x', (async () => {
      called = true
      return json({})
    }) as unknown as typeof fetch)
    expect(await c.score(WALLET, 'scroll')).toEqual({ ok: false, error: 'ChainScore does not score scroll' })
    expect(called).toBe(false)
  })

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
    expect(await res.json()).toEqual({ ok: false, status: 'degraded', dependencies: [{ name: 'fake', ok: false, detail: 'down' }] })
  })
})
