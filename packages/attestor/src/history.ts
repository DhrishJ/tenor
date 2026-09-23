/**
 * Independent borrowing-history check: per covered chain, "has this wallet
 * ever borrowed on Aave or Compound?", answered from chain data without
 * trusting ChainScore.
 *
 * Two sources:
 *   HyperSync (primary)  raw Aave Borrow logs + Compound borrow() transactions,
 *                        all 7 chains, full history.
 *   Alchemy (fallback)   Aave variable-debt-token mints to the wallet
 *                        (alchemy_getAssetTransfers), 5 chains only.
 *
 * KNOWN GAPS of the Alchemy fallback (stated, not hidden):
 *   - Avalanche and Scroll: getAssetTransfers is not offered there.
 *   - Compound V2: a borrow and a redeem both move the underlying from the
 *     cToken to the wallet, so transfer data cannot tell them apart. Compound
 *     stays unverified when Alchemy answers.
 *   - Historical stable-rate Aave borrows: the address book no longer lists
 *     stable debt tokens.
 *   - Only the Alchemy free plan's getAssetTransfers is used (its eth_getLogs
 *     is limited to a 10-block range on the free plan).
 *
 * The fallback protects against HyperSync throttling (our own load tripped its
 * free-tier limit on 2026-09-22/23) as much as against outages.
 */
import { pad, type Address } from 'viem'
import {
  AAVE_V2_BORROW_TOPIC,
  AAVE_V3_BORROW_TOPIC,
  COMPOUND_BORROW_SIGHASH,
  COVERED_CHAINS,
  type ChainSlug,
  type CoveredChain,
} from './coverage.js'
import aaveDebtTokens from './aaveDebtTokens.json' with { type: 'json' }

export type HistorySource = 'hypersync' | 'alchemy'

export type ChainHistory =
  | {
      ok: true
      aaveBorrows: number
      compoundBorrows: number
      source: HistorySource
      /** Protocols this source could NOT check on this chain. */
      unverified: Array<'compound'>
      /** Set when the primary failed and the fallback answered. */
      primaryError?: string
    }
  | { ok: false; error: string; attempted: HistorySource[] }

export interface HistoryChecker {
  check(wallet: Address): Promise<Record<ChainSlug, ChainHistory>>
}

export interface ChainHistorySource {
  readonly name: HistorySource
  checkChain(chain: CoveredChain, wallet: Address): Promise<ChainHistory>
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Checks chains one at a time (no fan-out), so one wallet never bursts. */
async function checkAllSerial(check: (c: CoveredChain) => Promise<ChainHistory>) {
  const out = {} as Record<ChainSlug, ChainHistory>
  for (const c of COVERED_CHAINS) out[c.slug] = await check(c)
  return out
}

// ======================================================================= HyperSync

export interface HyperSyncOptions {
  apiToken: string
  /** Default: https://<chainId>.hypersync.xyz (docs.envio.dev supported networks). */
  urlFor?: (chainId: number) => string
  fetchImpl?: typeof fetch
  timeoutMs?: number
  /** Safety bound on pagination; exceeding it is an error, never a partial answer. */
  maxPages?: number
  /** Minimum gap between requests, to stay inside the free tier's fair use. */
  minIntervalMs?: number
  /** Retries on HTTP 429, each after the server's reset hint or a backoff. */
  max429Retries?: number
}

interface HyperSyncResponse {
  data: Array<{ logs?: unknown[]; transactions?: unknown[] }>
  next_block: number
  archive_height: number
}

export class HyperSyncHistoryChecker implements HistoryChecker, ChainHistorySource {
  readonly name = 'hypersync' as const
  private readonly urlFor: (chainId: number) => string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly maxPages: number
  private readonly minIntervalMs: number
  private readonly max429Retries: number
  private lastRequestAt = 0

  constructor(private readonly opts: HyperSyncOptions) {
    this.urlFor = opts.urlFor ?? ((id) => `https://${id}.hypersync.xyz`)
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.timeoutMs = opts.timeoutMs ?? 20_000
    this.maxPages = opts.maxPages ?? 50
    this.minIntervalMs = opts.minIntervalMs ?? 250
    this.max429Retries = opts.max429Retries ?? 3
  }

  check(wallet: Address) {
    return checkAllSerial((c) => this.checkChain(c, wallet))
  }

  async checkChain(chain: CoveredChain, wallet: Address): Promise<ChainHistory> {
    try {
      const walletTopic = pad(wallet.toLowerCase() as Address, { size: 32 })
      const logSelections = [{ address: [chain.aaveV3Pool], topics: [[AAVE_V3_BORROW_TOPIC], [], [walletTopic]] }]
      if (chain.aaveV2Pool) {
        logSelections.push({ address: [chain.aaveV2Pool], topics: [[AAVE_V2_BORROW_TOPIC], [], [walletTopic]] })
      }
      // Separate queries: HyperSync's default join mode would add each matched
      // log's transaction to the transaction results.
      const aaveBorrows = await this.count(chain.chainId, { logs: logSelections, field_selection: { log: ['block_number'] } }, 'logs')
      let compoundBorrows = 0
      if (chain.compoundV2CTokens?.length) {
        compoundBorrows = await this.count(
          chain.chainId,
          {
            transactions: [{ from: [wallet], to: [...chain.compoundV2CTokens], sighash: [COMPOUND_BORROW_SIGHASH], status: 1 }],
            field_selection: { transaction: ['hash'] },
          },
          'transactions',
        )
      }
      return { ok: true, aaveBorrows, compoundBorrows, source: 'hypersync', unverified: [] }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), attempted: ['hypersync'] }
    }
  }

  /** Pages to the head as of the first response (chasing a moving head on a
   *  fast chain would never end) and counts matching records. */
  private async count(chainId: number, selection: Record<string, unknown>, kind: 'logs' | 'transactions') {
    let fromBlock = 0
    let total = 0
    let target: number | undefined
    for (let page = 0; page < this.maxPages; page++) {
      const res = await this.query(chainId, { from_block: fromBlock, ...selection })
      target ??= res.archive_height
      for (const block of res.data) total += (block[kind] ?? []).length
      if (res.next_block >= target) return total
      if (res.next_block <= fromBlock) throw new Error(`HyperSync did not advance on chain ${chainId}`)
      fromBlock = res.next_block
    }
    throw new Error(`HyperSync pagination exceeded ${this.maxPages} pages on chain ${chainId}`)
  }

  private async query(chainId: number, body: Record<string, unknown>): Promise<HyperSyncResponse> {
    for (let attempt = 0; ; attempt++) {
      const wait = this.lastRequestAt + this.minIntervalMs - Date.now()
      if (wait > 0) await sleep(wait)
      this.lastRequestAt = Date.now()
      const res = await this.fetchImpl(`${this.urlFor(chainId)}/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.opts.apiToken}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
      if (res.status === 429 && attempt < this.max429Retries) {
        // Honour the server's reset hint if present, bounded; otherwise back off.
        const hint = Number(res.headers.get('retry-after') ?? res.headers.get('x-ratelimit-reset'))
        await sleep(Math.min(Number.isFinite(hint) && hint > 0 ? hint * 1000 : 2000 * 2 ** attempt, 20_000))
        continue
      }
      if (!res.ok) throw new Error(`HyperSync HTTP ${res.status} on chain ${chainId}`)
      const json = (await res.json()) as Partial<HyperSyncResponse>
      if (!Array.isArray(json.data) || typeof json.next_block !== 'number' || typeof json.archive_height !== 'number') {
        throw new Error(`HyperSync returned an unexpected shape on chain ${chainId}`)
      }
      return json as HyperSyncResponse
    }
  }
}

// ========================================================================= Alchemy

export interface AlchemyOptions {
  apiKey: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
  maxPages?: number
  /** Default: https://<network>.g.alchemy.com/v2/<key> */
  urlFor?: (network: string, key: string) => string
}

const DEBT_TOKENS = (aaveDebtTokens as { chains: Partial<Record<ChainSlug, string[]>> }).chains

export class AlchemyHistorySource implements HistoryChecker, ChainHistorySource {
  readonly name = 'alchemy' as const
  private readonly fetchImpl: typeof fetch
  private readonly urlFor: (network: string, key: string) => string

  constructor(private readonly opts: AlchemyOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.urlFor = opts.urlFor ?? ((n, k) => `https://${n}.g.alchemy.com/v2/${k}`)
  }

  check(wallet: Address) {
    return checkAllSerial((c) => this.checkChain(c, wallet))
  }

  /** Counts Aave variable-debt-token mints to the wallet. An Aave borrow mints
   *  debt tokens to onBehalfOf, so this reads the same fact as the Borrow log,
   *  through a different provider. */
  async checkChain(chain: CoveredChain, wallet: Address): Promise<ChainHistory> {
    const tokens = DEBT_TOKENS[chain.slug]
    if (!chain.alchemyNetwork || !tokens?.length) {
      return { ok: false, error: `Alchemy fallback does not cover ${chain.name}`, attempted: ['alchemy'] }
    }
    try {
      let mints = 0
      let pageKey: string | undefined
      for (let page = 0; page < (this.opts.maxPages ?? 20); page++) {
        const params: Record<string, unknown> = {
          fromBlock: '0x0',
          toBlock: 'latest',
          // Debt tokens are non-transferable: any transfer TO the wallet is a mint.
          toAddress: wallet,
          contractAddresses: tokens,
          category: ['erc20'],
          excludeZeroValue: true,
          maxCount: '0x3e8',
        }
        if (pageKey) params.pageKey = pageKey
        const res = await this.fetchImpl(this.urlFor(chain.alchemyNetwork, this.opts.apiKey), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'alchemy_getAssetTransfers', params: [params] }),
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 20_000),
        })
        if (!res.ok) throw new Error(`Alchemy HTTP ${res.status} on ${chain.name}`)
        const json = (await res.json()) as { result?: { transfers?: unknown[]; pageKey?: string }; error?: { message?: string } }
        if (json.error || !json.result || !Array.isArray(json.result.transfers)) {
          throw new Error(`Alchemy error on ${chain.name}: ${json.error?.message ?? 'unexpected shape'}`)
        }
        mints += json.result.transfers.length
        pageKey = json.result.pageKey
        if (!pageKey) {
          return {
            ok: true,
            aaveBorrows: mints,
            compoundBorrows: 0,
            source: 'alchemy',
            unverified: chain.compoundV2CTokens?.length ? ['compound'] : [],
          }
        }
      }
      throw new Error(`Alchemy pagination exceeded on ${chain.name}`)
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), attempted: ['alchemy'] }
    }
  }
}

// ======================================================================== Fallback

/** HyperSync first; Alchemy for any chain where HyperSync failed. Reports
 *  which source answered each chain and which failed. */
export class FallbackHistoryChecker implements HistoryChecker {
  constructor(
    private readonly primary: ChainHistorySource,
    private readonly fallback: ChainHistorySource,
  ) {}

  check(wallet: Address) {
    return checkAllSerial(async (c) => {
      const p = await this.primary.checkChain(c, wallet)
      if (p.ok) return p
      const f = await this.fallback.checkChain(c, wallet)
      if (f.ok) return { ...f, primaryError: p.error }
      return { ok: false, error: `${p.error}; ${f.error}`, attempted: [this.primary.name, this.fallback.name] }
    })
  }
}
