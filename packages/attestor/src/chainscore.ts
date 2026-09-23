/**
 * ChainScore client. ChainScore is PRIOR ART, called over the network as a
 * black box. Its responses are UNTRUSTED INPUT: every field is parsed and
 * validated before anything is signed (validate.ts).
 *
 * The specific problem this layer exists for: the upstream does not
 * distinguish "no data" from "provider failed". A wallet whose transaction
 * history came back empty can still receive a confident score.
 *
 * Endpoint: the legacy GET /api/score/{address}?chain={slug} (see OBJECTIONS
 * P2-O13). It returns walletAge and totalTxns, which the consistency check
 * needs and the v1 envelope omits. It recomputes on every call (no cache, no
 * last-known-good) and allows 20 requests per minute per IP.
 */
import { z } from 'zod'
import type { Address } from 'viem'
import { isChainScoreSlug, type ChainSlug } from './coverage.js'

/** Fields Tenor relies on. Unknown extra fields are ignored; missing or
 *  mistyped required fields make the whole response invalid. */
export const legacyScoreSchema = z.object({
  score: z.number(),
  newWallet: z.boolean(),
  noBorrowHistory: z.boolean().optional(),
  walletAge: z.number(),
  totalTxns: z.number(),
  protocolsUsed: z.array(z.string()),
  degradedSources: z.array(z.string()).optional(),
  /** Computation time, ms since epoch. */
  timestamp: z.number(),
  modelVersion: z.string().optional(),
})

export type ChainScoreResult = z.infer<typeof legacyScoreSchema>

export type UpstreamResponse =
  | { ok: true; data: ChainScoreResult }
  | { ok: false; error: string }

export interface ChainScoreClient {
  score(wallet: Address, chain: ChainSlug): Promise<UpstreamResponse>
}

export class LegacyChainScoreClient implements ChainScoreClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 60_000,
  ) {}

  async score(wallet: Address, chain: ChainSlug): Promise<UpstreamResponse> {
    // Never send a slug ChainScore does not serve: it would answer with
    // Ethereum data instead of an error (ChainScore issue #21).
    if (!isChainScoreSlug(chain)) return { ok: false, error: `ChainScore does not score ${chain}` }
    const url = `${this.baseUrl.replace(/\/$/, '')}/api/score/${wallet}?chain=${chain}`
    let res: Response
    try {
      res = await this.fetchImpl(url, { signal: AbortSignal.timeout(this.timeoutMs) })
    } catch (e) {
      return { ok: false, error: `ChainScore unreachable (${e instanceof Error ? e.message : String(e)})` }
    }
    if (res.status === 429) return { ok: false, error: 'ChainScore rate limit reached' }
    if (!res.ok) return { ok: false, error: `ChainScore HTTP ${res.status}` }
    let body: unknown
    try {
      body = await res.json()
    } catch {
      return { ok: false, error: 'ChainScore returned non-JSON' }
    }
    const parsed = legacyScoreSchema.safeParse(body)
    if (!parsed.success) return { ok: false, error: 'ChainScore response failed schema validation' }
    return { ok: true, data: parsed.data }
  }
}
