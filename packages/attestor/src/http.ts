/**
 * HTTP adapter (Hono). Thin: validation, rate limits, request ids, and JSON
 * shapes. All decisions live in service.ts.
 */
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { getAddress, isAddress, type Address } from 'viem'
import type { AttestationService } from './service.js'
import type { Store } from './store.js'
import type { Logger } from './log.js'

export interface HealthCheck {
  name: string
  check: () => Promise<{ ok: boolean; detail: string }>
}

export interface HttpDeps {
  service: AttestationService
  store: Store
  log: Logger
  health: HealthCheck[]
  rateLimitPerIp: number
  rateLimitPerAddress: number
  now?: () => number
  corsOrigins?: string[]
  /** Added to every scoring response when set (e.g. fixture mode). */
  notice?: string
}

const WINDOW_MS = 60_000

export function createApp(d: HttpDeps) {
  const app = new Hono()
  const now = d.now ?? Date.now
  const notice = d.notice ? { notice: d.notice } : {}
  if (d.corsOrigins?.length) app.use('*', cors({ origin: d.corsOrigins, allowMethods: ['GET', 'POST'] }))

  app.use('*', async (c, next) => {
    const requestId = c.req.header('x-request-id') ?? crypto.randomUUID()
    c.set('requestId' as never, requestId as never)
    c.header('x-request-id', requestId)
    const t = now()
    await next()
    d.log.info('request', { requestId, method: c.req.method, path: c.req.path, status: c.res.status, ms: now() - t })
  })

  const clientIp = (c: { req: { header: (n: string) => string | undefined } }) =>
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local'

  async function limited(ip: string, wallet: Address) {
    const t = now()
    if (!(await d.store.hit(`ip:${ip}`, d.rateLimitPerIp, WINDOW_MS, t))) return 'Too many requests from this IP'
    if (!(await d.store.hit(`addr:${wallet.toLowerCase()}`, d.rateLimitPerAddress, WINDOW_MS, t))) {
      return 'Too many requests for this address'
    }
    return null
  }

  app.post('/attest', async (c) => {
    const body = await c.req.json().catch(() => null)
    const raw = body && typeof body === 'object' ? (body as { address?: unknown }).address : undefined
    if (typeof raw !== 'string' || !isAddress(raw)) return c.json({ error: 'body must be {"address": "0x..."}' }, 400)
    const wallet = getAddress(raw)
    const why = await limited(clientIp(c), wallet)
    if (why) return c.json({ error: why }, 429)
    const requestId = c.get('requestId' as never) as string
    const result = await d.service.attest(wallet, requestId)
    return c.json({ requestId, ...notice, ...result }, result.state === 'UNAVAILABLE' ? 503 : 200)
  })

  app.get('/score/:address', async (c) => {
    const raw = c.req.param('address')
    if (!isAddress(raw)) return c.json({ error: 'invalid address' }, 400)
    const wallet = getAddress(raw)
    const why = await limited(clientIp(c), wallet)
    if (why) return c.json({ error: why }, 429)
    const requestId = c.get('requestId' as never) as string
    const result = await d.service.evaluate(wallet, requestId, 'score')
    return c.json({ requestId, ...notice, ...result }, result.state === 'UNAVAILABLE' ? 503 : 200)
  })

  /** Every refusal with its reason: the live answer to "what happens if the data is bad?". */
  app.get('/refusals', async (c) => {
    const limit = Math.min(Number(c.req.query('limit') ?? 50) || 50, 200)
    return c.json({ refusals: await d.store.listRefusals(limit) })
  })

  app.get('/health', async (c) => {
    const results = await Promise.all(
      d.health.map(async (h) => {
        try {
          return { name: h.name, ...(await h.check()) }
        } catch (e) {
          return { name: h.name, ok: false, detail: e instanceof Error ? e.message : String(e) }
        }
      }),
    )
    const ok = results.every((r) => r.ok)
    return c.json({ ok, status: ok ? 'ok' : 'degraded', dependencies: results }, ok ? 200 : 503)
  })

  return app
}
