/**
 * Daily keep-alive (OBJECTIONS P4-O3, P4-O13, brief §4):
 *   1. re-stamps the mock oracle's prices (same values) so a judge arriving
 *      days later doesn't hit "price stale";
 *   2. queries the hosted indexer so Envio's free tier doesn't delete it for
 *      being idle.
 * Signs with its own throwaway ORACLE_KEEPER key, never the deployer's.
 *
 * The last run is persisted in the store, and /health reports DEGRADED when
 * the keeper is overdue or its last run failed, and when a price is older
 * than the keeper should allow, so a stale oracle is visible rather than
 * inferred.
 */
import {
  createWalletClient,
  defineChain,
  http,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { HealthCheck } from './http.js'
import type { Logger } from './log.js'
import type { Store } from './store.js'

export const oracleAbi = parseAbi([
  'function getPrice(address asset) view returns (uint256 priceWad, uint256 updatedAt)',
  'function setPrice(address asset, uint256 priceWad)',
  'function owner() view returns (address)',
])

export interface KeeperStep {
  name: string
  run: () => Promise<string>
}

export interface KeeperRun {
  at: string
  ok: boolean
  steps: Array<{ name: string; ok: boolean; detail: string }>
}

const META_KEY = 'keeper:lastRun'
/** A run may be this late before /health calls the keeper overdue. */
const GRACE_MS = 60 * 60 * 1000

export class Keeper {
  private timer: NodeJS.Timeout | undefined
  private running = false

  constructor(
    private readonly d: {
      steps: KeeperStep[]
      store: Store
      log: Logger
      intervalMs: number
      now?: () => number
    },
  ) {}

  private now() {
    return (this.d.now ?? Date.now)()
  }

  async lastRun(): Promise<KeeperRun | undefined> {
    const raw = await this.d.store.getMeta(META_KEY)
    return raw ? (JSON.parse(raw) as KeeperRun) : undefined
  }

  async runOnce(): Promise<KeeperRun> {
    if (this.running) throw new Error('keeper already running')
    this.running = true
    try {
      const steps: KeeperRun['steps'] = []
      for (const s of this.d.steps) {
        try {
          steps.push({ name: s.name, ok: true, detail: await s.run() })
        } catch (e) {
          steps.push({ name: s.name, ok: false, detail: e instanceof Error ? e.message.split('\n')[0]! : String(e) })
        }
      }
      const run: KeeperRun = { at: new Date(this.now()).toISOString(), ok: steps.every((s) => s.ok), steps }
      await this.d.store.setMeta(META_KEY, JSON.stringify(run))
      ;(run.ok ? this.d.log.info : this.d.log.error)('keeper_run', { ok: run.ok, steps: run.steps })
      return run
    } finally {
      this.running = false
    }
  }

  /** Runs now if the last run is due (or missing), then every interval. Survives restarts via the store. */
  async start() {
    const last = await this.lastRun()
    const since = last ? this.now() - Date.parse(last.at) : Infinity
    const firstDelay = since >= this.d.intervalMs || !last?.ok ? 0 : this.d.intervalMs - since
    const tick = async () => {
      await this.runOnce().catch((e) => this.d.log.error('keeper_crash', { error: String(e) }))
      this.timer = setTimeout(tick, this.d.intervalMs)
    }
    this.timer = setTimeout(tick, firstDelay)
    this.d.log.info('keeper_scheduled', { firstRunInMs: firstDelay, intervalMs: this.d.intervalMs })
  }

  stop() {
    if (this.timer) clearTimeout(this.timer)
  }

  health(): HealthCheck {
    return {
      name: 'keeper',
      check: async () => {
        const last = await this.lastRun()
        if (!last) return { ok: false, detail: 'DEGRADED: keeper has never run' }
        const age = this.now() - Date.parse(last.at)
        const summary = last.steps.map((s) => `${s.name} ${s.ok ? 'ok' : 'FAILED'}: ${s.detail}`).join('; ')
        if (age > this.d.intervalMs + GRACE_MS) {
          return { ok: false, detail: `DEGRADED: last run ${last.at} is overdue (${Math.round(age / 3.6e6)} h ago). ${summary}` }
        }
        if (!last.ok) return { ok: false, detail: `DEGRADED: last run ${last.at} failed. ${summary}` }
        return { ok: true, detail: `last run ${last.at}. ${summary}` }
      },
    }
  }
}

/** Degraded once any price is older than the keeper should allow; says plainly when borrowing has stopped. */
export function oracleFreshnessCheck(d: {
  client: PublicClient
  oracle: Address
  assets: Array<{ symbol: string; address: Address }>
  maxPriceAgeSec: number
  keeperIntervalMs: number
  now?: () => number
}): HealthCheck {
  return {
    name: 'oracle-freshness',
    check: async () => {
      const nowSec = Math.floor((d.now ?? Date.now)() / 1000)
      const warnAfter = Math.floor((d.keeperIntervalMs + GRACE_MS) / 1000)
      const parts: string[] = []
      let ok = true
      for (const a of d.assets) {
        const [, updatedAt] = await d.client.readContract({ address: d.oracle, abi: oracleAbi, functionName: 'getPrice', args: [a.address] })
        const age = nowSec - Number(updatedAt)
        if (age >= d.maxPriceAgeSec) {
          ok = false
          parts.push(`${a.symbol} STALE (${Math.round(age / 3600)} h): borrowing and liquidation revert`)
        } else if (age > warnAfter) {
          ok = false
          parts.push(`${a.symbol} DEGRADED: ${Math.round(age / 3600)} h old, keeper should have re-stamped`)
        } else {
          parts.push(`${a.symbol} ${Math.round(age / 60)} min old`)
        }
      }
      return { ok, detail: `${parts.join('; ')} (max age ${d.maxPriceAgeSec / 3600} h)` }
    },
  }
}

/** Step 1: re-stamp each asset's current price. Same value; only updatedAt moves. */
export function restampStep(d: {
  client: PublicClient
  rpcUrl: string
  chainId: number
  keeperKey: Hex
  oracle: Address
  assets: Address[]
}): KeeperStep {
  const account = privateKeyToAccount(d.keeperKey)
  const chain = defineChain({
    id: d.chainId,
    name: `chain-${d.chainId}`,
    nativeCurrency: { name: 'native', symbol: 'NATIVE', decimals: 18 },
    rpcUrls: { default: { http: [d.rpcUrl] } },
  })
  const wallet = createWalletClient({ account, chain, transport: http(d.rpcUrl) })
  return {
    name: 'oracle-restamp',
    run: async () => {
      const owner = await d.client.readContract({ address: d.oracle, abi: oracleAbi, functionName: 'owner' })
      if (owner.toLowerCase() !== account.address.toLowerCase()) {
        throw new Error(`keeper ${account.address} is not the oracle owner (${owner})`)
      }
      const hashes: string[] = []
      for (const asset of d.assets) {
        const [price] = await d.client.readContract({ address: d.oracle, abi: oracleAbi, functionName: 'getPrice', args: [asset] })
        const hash = await wallet.writeContract({ address: d.oracle, abi: oracleAbi, functionName: 'setPrice', args: [asset, price] })
        const r = await d.client.waitForTransactionReceipt({ hash, timeout: 60_000 })
        if (r.status !== 'success') throw new Error(`setPrice reverted: ${hash}`)
        hashes.push(hash)
      }
      return `re-stamped ${d.assets.length} prices: ${hashes.join(', ')}`
    },
  }
}

/** Step 2: a real query against the hosted indexer, so it isn't idle. */
export function indexerPingStep(indexerUrl: string, fetchImpl: typeof fetch = fetch): KeeperStep {
  return {
    name: 'indexer-ping',
    run: async () => {
      const res = await fetchImpl(indexerUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: '{ MarketTotals(limit: 1) { id borrowCount } }' }),
        signal: AbortSignal.timeout(15_000),
      })
      const body = (await res.json().catch(() => null)) as { data?: { MarketTotals?: unknown[] }; errors?: unknown } | null
      if (!res.ok || !body?.data) throw new Error(`indexer HTTP ${res.status}${body?.errors ? `: ${JSON.stringify(body.errors).slice(0, 200)}` : ''}`)
      return `indexer answered (MarketTotals rows: ${body.data.MarketTotals?.length ?? 0})`
    },
  }
}
