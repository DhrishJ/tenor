/**
 * Independent borrowing-history check.
 *
 * Answers, per covered chain, "has this wallet ever borrowed on Aave or
 * Compound?" from raw chain data (Envio HyperSync), without trusting ChainScore.
 * It is independent of ChainScore's pipeline (different provider, raw logs
 * instead of subgraphs), not of the chains themselves.
 *
 * What it catches: ChainScore reporting "no borrowing history" or "new wallet"
 * where borrowing exists, and ChainScore scoring a chain with none. What it
 * does NOT catch: a borrower whose other ChainScore inputs silently failed
 * (the "850 with 0 transactions" case). That is the consistency check's job,
 * in validate.ts.
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

export type ChainHistory =
  | { ok: true; aaveBorrows: number; compoundBorrows: number }
  | { ok: false; error: string }

export interface HistoryChecker {
  check(wallet: Address): Promise<Record<ChainSlug, ChainHistory>>
}

export interface HyperSyncOptions {
  apiToken: string
  /** Default: https://<chainId>.hypersync.xyz (docs.envio.dev supported networks). */
  urlFor?: (chainId: number) => string
  fetchImpl?: typeof fetch
  timeoutMs?: number
  /** Safety bound on pagination; exceeding it is an error, never a partial answer. */
  maxPages?: number
}

interface HyperSyncResponse {
  data: Array<{ logs?: unknown[]; transactions?: Array<{ status?: number }> }>
  next_block: number
  archive_height: number
}

export class HyperSyncHistoryChecker implements HistoryChecker {
  private readonly urlFor: (chainId: number) => string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly maxPages: number

  constructor(private readonly opts: HyperSyncOptions) {
    this.urlFor = opts.urlFor ?? ((id) => `https://${id}.hypersync.xyz`)
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.timeoutMs = opts.timeoutMs ?? 20_000
    this.maxPages = opts.maxPages ?? 50
  }

  async check(wallet: Address): Promise<Record<ChainSlug, ChainHistory>> {
    const entries = await Promise.all(
      COVERED_CHAINS.map(async (c) => [c.slug, await this.checkChain(c, wallet)] as const),
    )
    return Object.fromEntries(entries) as Record<ChainSlug, ChainHistory>
  }

  private async checkChain(chain: CoveredChain, wallet: Address): Promise<ChainHistory> {
    try {
      const walletTopic = pad(wallet.toLowerCase() as Address, { size: 32 })
      const logSelections = [{ address: [chain.aaveV3Pool], topics: [[AAVE_V3_BORROW_TOPIC], [], [walletTopic]] }]
      if (chain.aaveV2Pool) {
        logSelections.push({ address: [chain.aaveV2Pool], topics: [[AAVE_V2_BORROW_TOPIC], [], [walletTopic]] })
      }
      // Logs and transactions are separate queries: HyperSync's default join
      // mode would otherwise add each matched log's transaction to the
      // transaction results and inflate the Compound count.
      const aaveLogs = await this.count(chain.chainId, {
        logs: logSelections,
        field_selection: { log: ['block_number', 'transaction_hash'] },
      }, 'logs')

      let compoundTxs = 0
      if (chain.compoundV2CTokens?.length) {
        compoundTxs = await this.count(chain.chainId, {
          transactions: [
            { from: [wallet], to: [...chain.compoundV2CTokens], sighash: [COMPOUND_BORROW_SIGHASH], status: 1 },
          ],
          field_selection: { transaction: ['hash', 'status'] },
        }, 'transactions')
      }
      return { ok: true, aaveBorrows: aaveLogs, compoundBorrows: compoundTxs }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  /** Pages through the whole chain history and counts matching records. */
  private async count(chainId: number, selection: Record<string, unknown>, kind: 'logs' | 'transactions') {
    let fromBlock = 0
    let total = 0
    // Scan up to the head as it was at the first response. Chasing a moving
    // head on a fast chain would never terminate.
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
    const res = await this.fetchImpl(`${this.urlFor(chainId)}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.opts.apiToken}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    if (!res.ok) throw new Error(`HyperSync HTTP ${res.status} on chain ${chainId}`)
    const json = (await res.json()) as Partial<HyperSyncResponse>
    if (!Array.isArray(json.data) || typeof json.next_block !== 'number' || typeof json.archive_height !== 'number') {
      throw new Error(`HyperSync returned an unexpected shape on chain ${chainId}`)
    }
    return json as HyperSyncResponse
  }
}
