/** Local entry point: wires real dependencies from config and serves HTTP. */
import { serve } from '@hono/node-server'
import { createPublicClient, http } from 'viem'
import { loadConfig, LOCAL_CHAIN_ID } from './config.js'
import { LegacyChainScoreClient } from './chainscore.js'
import { AlchemyHistorySource, FallbackHistoryChecker, HyperSyncHistoryChecker, type HistoryChecker } from './history.js'
import { createApp, type HealthCheck } from './http.js'
import { jsonLogger } from './log.js'
import { ViemRegistryReader } from './registry.js'
import { AttestationService } from './service.js'
import { AttestationSigner } from './signer.js'
import { MemoryStore, type Store } from './store.js'
import { PgStore } from './pgStore.js'
import { Keeper, indexerPingStep, oracleFreshnessCheck, restampStep, type KeeperStep } from './keeper.js'
import { FixtureHistoryChecker } from './fixtureHistory.js'

const cfg = loadConfig()
const client = createPublicClient({ transport: http(cfg.rpcUrl) })
const signer = new AttestationSigner(cfg.attestorKey, { ...cfg.eip712, chainId: cfg.chainId, verifyingContract: cfg.registry })

// Refuse to start with a key the registry will not accept: every signature
// would be rejected on-chain.
if (signer.address !== cfg.expectedAttestor) {
  jsonLogger.error('attestor_mismatch', { signer: signer.address, deploymentAttestor: cfg.expectedAttestor })
  process.exit(1)
}

const hypersync = new HyperSyncHistoryChecker({ apiToken: cfg.envioToken })
const fixture = cfg.historyFixture ? new FixtureHistoryChecker(cfg.historyFixture) : undefined
if (fixture && cfg.chainId !== 31337) {
  jsonLogger.error('fixture_on_non_local_chain', { chainId: cfg.chainId })
  process.exit(1)
}
const history: HistoryChecker = fixture
  ? fixture
  : cfg.alchemyKey
    ? new FallbackHistoryChecker(hypersync, new AlchemyHistorySource({ apiKey: cfg.alchemyKey }))
    : hypersync
const notice = fixture
  ? `FIXTURE: borrowing history replayed from a recording, not queried live. ${fixture.source} ChainScore scores are live.`
  : undefined

// Off the local chain, a restart must not forget nonce reservations (brief §5),
// and the oracle must be kept fresh (P4-O13): refuse to start without either.
if (cfg.chainId !== LOCAL_CHAIN_ID) {
  const missing = [
    !cfg.databaseUrl && 'DATABASE_URL',
    !cfg.oracleKeeperKey && 'ORACLE_KEEPER_PRIVATE_KEY',
    !cfg.oracle && 'mockPriceOracle/tUSD/tCOLL/maxPriceAge in the deployments file',
  ].filter(Boolean)
  if (missing.length) {
    jsonLogger.error('missing_production_config', { missing })
    process.exit(1)
  }
}
let store: Store
if (cfg.databaseUrl) {
  const pgStore = new PgStore({ connectionString: cfg.databaseUrl, caCert: cfg.databaseCaCert })
  await pgStore.migrate()
  store = pgStore
} else {
  store = new MemoryStore()
}
const registry = new ViemRegistryReader(client, cfg.registry)
const service = new AttestationService({
  history,
  chainscore: new LegacyChainScoreClient(cfg.chainscoreBaseUrl),
  registry,
  signer,
  store,
  log: jsonLogger,
  scoreTtlSeconds: cfg.scoreTtlSeconds,
  submitWindowSeconds: cfg.submitWindowSeconds,
})

const health: HealthCheck[] = [
  {
    name: 'rpc',
    check: async () => {
      const id = await client.getChainId()
      return { ok: id === cfg.chainId, detail: `chainId ${id} (expected ${cfg.chainId})` }
    },
  },
  {
    name: 'registry-attestor',
    check: async () => {
      const a = await registry.attestor()
      return { ok: a === signer.address, detail: `registry attestor ${a}, service signer ${signer.address}` }
    },
  },
  {
    name: 'hypersync',
    check: async () => {
      const res = await fetch('https://1.hypersync.xyz/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.envioToken}` },
        body: JSON.stringify({ from_block: 0, to_block: 1, logs: [{}] }),
        signal: AbortSignal.timeout(10_000),
      })
      return { ok: res.ok, detail: `HTTP ${res.status}` }
    },
  },
  {
    name: 'history-fallback',
    check: async () => ({
      ok: Boolean(cfg.alchemyKey),
      detail: cfg.alchemyKey ? 'Alchemy fallback configured' : 'ALCHEMY_API_KEY not set: HyperSync only, no fallback',
    }),
  },
  {
    name: 'chainscore',
    check: async () => {
      // A static route, so health checks do not spend the scoring rate limit.
      const res = await fetch(`${cfg.chainscoreBaseUrl}/api/v1/openapi`, { signal: AbortSignal.timeout(10_000) })
      return { ok: res.ok, detail: `HTTP ${res.status}` }
    },
  },
]

const keeperSteps: KeeperStep[] = []
if (cfg.oracleKeeperKey && cfg.oracle) {
  keeperSteps.push(
    restampStep({
      client,
      rpcUrl: cfg.rpcUrl,
      chainId: cfg.chainId,
      keeperKey: cfg.oracleKeeperKey,
      oracle: cfg.oracle.address,
      assets: [cfg.oracle.tUSD, cfg.oracle.tCOLL],
    }),
  )
}
if (cfg.indexerUrl) keeperSteps.push(indexerPingStep(cfg.indexerUrl))
if (keeperSteps.length) {
  const keeper = new Keeper({ steps: keeperSteps, store, log: jsonLogger, intervalMs: cfg.keeperIntervalMs })
  health.push(keeper.health())
  await keeper.start()
}
if (!cfg.indexerUrl && cfg.chainId !== LOCAL_CHAIN_ID) {
  health.push({ name: 'indexer-keepalive', check: async () => ({ ok: false, detail: 'DEGRADED: INDEXER_URL not set; the hosted indexer is not being kept alive' }) })
}
if (cfg.oracle) {
  health.push(
    oracleFreshnessCheck({
      client,
      oracle: cfg.oracle.address,
      assets: [
        { symbol: 'tUSD', address: cfg.oracle.tUSD },
        { symbol: 'tCOLL', address: cfg.oracle.tCOLL },
      ],
      maxPriceAgeSec: cfg.oracle.maxPriceAge,
      keeperIntervalMs: cfg.keeperIntervalMs,
    }),
  )
}
health.push({
  name: 'store',
  check: async () => ({ ok: true, detail: cfg.databaseUrl ? 'Postgres (survives restarts)' : 'in-memory (local only; lost on restart)' }),
})

const app = createApp({
  service,
  store,
  log: jsonLogger,
  health,
  rateLimitPerIp: cfg.rateLimitPerIp,
  rateLimitPerAddress: cfg.rateLimitPerAddress,
  corsOrigins: cfg.corsOrigins,
  notice,
})

serve({ fetch: app.fetch, port: cfg.port })
jsonLogger.info('listening', { port: cfg.port, chainId: cfg.chainId, registry: cfg.registry, signer: signer.address })
