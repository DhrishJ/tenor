/**
 * Postgres implementation of Store (Supabase in deployment, OBJECTIONS P4-O12).
 * Everything the service must not forget across a restart lives here: nonce
 * reservations above all, plus caches, rate-limit counters, the refusal log
 * and keeper metadata.
 *
 * Scoped per deployment (chain id + registry address): reservations, the
 * refusal log and keeper metadata belong to one deployment, and a rehearsal
 * and a final deployment on the same chain may share a database. The score
 * and history caches describe mainnet wallets, so they are shared.
 *
 * Rate limits use a fixed window here (the in-memory store uses a sliding
 * one): one upsert per hit, and at most 2x the limit across a window edge.
 */
import pg from 'pg'
import type { Address } from 'viem'
import type { ChainSlug } from './coverage.js'
import type { Attestation } from './signer.js'
import type { ChainHistory } from './history.js'
import type { CachedChainScore, RefusalEntry, Store } from './store.js'

const SCHEMA = `
create table if not exists tenor_chain_scores (
  wallet text not null, chain text not null, value jsonb not null, expires_at_ms bigint not null,
  primary key (wallet, chain));
create table if not exists tenor_histories (
  wallet text primary key, value jsonb not null, expires_at_ms bigint not null);
create table if not exists tenor_reservations (
  wallet text not null, nonce numeric not null, payload jsonb not null,
  primary key (wallet, nonce));
create table if not exists tenor_rate_hits (
  key text not null, window_start_ms bigint not null, hits int not null,
  primary key (key, window_start_ms));
create table if not exists tenor_refusals (
  id bigserial primary key, entry jsonb not null);
create table if not exists tenor_meta (
  key text primary key, value text not null);
alter table tenor_refusals add column if not exists scope text;
create index if not exists tenor_refusals_scope on tenor_refusals (scope, id);
`

/** Attestation carries bigints; JSON can't. */
const encode = (a: Attestation) => ({
  ...a,
  issuedAt: a.issuedAt.toString(),
  expiresAt: a.expiresAt.toString(),
  deadline: a.deadline.toString(),
  nonce: a.nonce.toString(),
})
type Encoded = ReturnType<typeof encode>
const decode = (e: Encoded): Attestation => ({
  ...e,
  issuedAt: BigInt(e.issuedAt),
  expiresAt: BigInt(e.expiresAt),
  deadline: BigInt(e.deadline),
  nonce: BigInt(e.nonce),
})

export interface PgStoreOptions {
  connectionString: string
  /** Deployment this service instance serves, e.g. "10143:0xregistry". */
  scope: string
  /** PEM of the server's CA (Supabase publishes one). Omit for a local database without TLS. */
  caCert?: string
}

export class PgStore implements Store {
  readonly pool: pg.Pool
  private readonly scope: string

  constructor(opts: PgStoreOptions) {
    this.scope = opts.scope.toLowerCase()
    this.pool = new pg.Pool({
      connectionString: opts.connectionString,
      max: 5,
      ...(opts.caCert ? { ssl: { ca: opts.caCert, rejectUnauthorized: true } } : {}),
    })
  }

  async migrate() {
    await this.pool.query(SCHEMA)
  }

  async close() {
    await this.pool.end()
  }

  async getChainScore(wallet: Address, chain: ChainSlug, nowMs: number) {
    const r = await this.pool.query<{ value: CachedChainScore }>(
      'select value from tenor_chain_scores where wallet = $1 and chain = $2 and expires_at_ms > $3',
      [wallet.toLowerCase(), chain, nowMs],
    )
    return r.rows[0]?.value
  }

  async putChainScore(wallet: Address, chain: ChainSlug, value: CachedChainScore, expiresAtMs: number) {
    await this.pool.query(
      `insert into tenor_chain_scores (wallet, chain, value, expires_at_ms) values ($1, $2, $3, $4)
       on conflict (wallet, chain) do update set value = excluded.value, expires_at_ms = excluded.expires_at_ms`,
      [wallet.toLowerCase(), chain, JSON.stringify(value), expiresAtMs],
    )
  }

  async deleteChainScores(wallet: Address) {
    await this.pool.query('delete from tenor_chain_scores where wallet = $1', [wallet.toLowerCase()])
  }

  async getHistory(wallet: Address, nowMs: number) {
    const r = await this.pool.query<{ value: Record<ChainSlug, ChainHistory> }>(
      'select value from tenor_histories where wallet = $1 and expires_at_ms > $2',
      [wallet.toLowerCase(), nowMs],
    )
    return r.rows[0]?.value
  }

  async putHistory(wallet: Address, value: Record<ChainSlug, ChainHistory>, expiresAtMs: number) {
    await this.pool.query(
      `insert into tenor_histories (wallet, value, expires_at_ms) values ($1, $2, $3)
       on conflict (wallet) do update set value = excluded.value, expires_at_ms = excluded.expires_at_ms`,
      [wallet.toLowerCase(), JSON.stringify(value), expiresAtMs],
    )
  }

  // Atomic across processes: the row is created if absent, then locked, so two
  // concurrent requests for one (wallet, nonce) serialize on the row lock and
  // the second sees the first's payload.
  async reserve(wallet: Address, nonce: bigint, payload: Attestation, nowMs: number, lastLiquidatedAt: number) {
    const w = `${this.scope}:${wallet.toLowerCase()}`
    const n = nonce.toString()
    const c = await this.pool.connect()
    try {
      await c.query('begin')
      const ins = await c.query(
        `insert into tenor_reservations (wallet, nonce, payload) values ($1, $2, $3)
         on conflict (wallet, nonce) do nothing returning wallet`,
        [w, n, JSON.stringify(encode(payload))],
      )
      if (ins.rowCount === 1) {
        await c.query('commit')
        return { payload, reused: false }
      }
      const r = await c.query<{ payload: Encoded }>(
        'select payload from tenor_reservations where wallet = $1 and nonce = $2 for update',
        [w, n],
      )
      const existing = decode(r.rows[0]!.payload)
      const live = Number(existing.deadline) * 1000 > nowMs && Number(existing.issuedAt) > lastLiquidatedAt
      if (live) {
        await c.query('commit')
        return { payload: existing, reused: true }
      }
      await c.query('update tenor_reservations set payload = $3 where wallet = $1 and nonce = $2', [
        w,
        n,
        JSON.stringify(encode(payload)),
      ])
      await c.query('commit')
      return { payload, reused: false }
    } catch (e) {
      await c.query('rollback').catch(() => {})
      throw e
    } finally {
      c.release()
    }
  }

  async hit(key: string, max: number, windowMs: number, nowMs: number) {
    const windowStart = nowMs - (nowMs % windowMs)
    const r = await this.pool.query<{ hits: number }>(
      `insert into tenor_rate_hits (key, window_start_ms, hits) values ($1, $2, 1)
       on conflict (key, window_start_ms) do update set hits = tenor_rate_hits.hits + 1
       returning hits`,
      [key, windowStart],
    )
    // Old windows are never read again; prune opportunistically.
    if (Math.random() < 0.01) {
      await this.pool.query('delete from tenor_rate_hits where window_start_ms < $1', [windowStart - windowMs])
    }
    return r.rows[0]!.hits <= max
  }

  async logRefusal(entry: RefusalEntry) {
    await this.pool.query('insert into tenor_refusals (scope, entry) values ($1, $2)', [this.scope, JSON.stringify(entry)])
  }

  async listRefusals(limit: number) {
    const r = await this.pool.query<{ entry: RefusalEntry }>(
      'select entry from tenor_refusals where scope = $1 order by id desc limit $2',
      [this.scope, limit],
    )
    return r.rows.map((x) => x.entry)
  }

  async getMeta(key: string) {
    const r = await this.pool.query<{ value: string }>('select value from tenor_meta where key = $1', [`${this.scope}:${key}`])
    return r.rows[0]?.value
  }

  async setMeta(key: string, value: string) {
    await this.pool.query(
      'insert into tenor_meta (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value',
      [`${this.scope}:${key}`, value],
    )
  }
}
