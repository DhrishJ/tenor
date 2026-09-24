// Display-only live evaluation of one wallet (no signing, no chain writes).
// Usage: ENVIO_API_TOKEN=... [ALCHEMY_API_KEY=...] [NO_HYPERSYNC=1] tsx scripts/evaluate.ts <address>
// Prints the result plus every chain ChainScore was asked about, so "no
// ChainScore query for Scroll" is checked, not assumed. NO_HYPERSYNC=1 makes
// the primary history source fail, to exercise the Alchemy path.
import { getAddress, type Address } from 'viem'
import { AlchemyHistorySource, FallbackHistoryChecker, HyperSyncHistoryChecker, type HistoryChecker } from '../src/history.js'
import { LegacyChainScoreClient, type ChainScoreClient } from '../src/chainscore.js'
import type { ChainSlug } from '../src/coverage.js'
import { AttestationService } from '../src/service.js'
import { MemoryStore } from '../src/store.js'
import { silentLogger } from '../src/log.js'

const registry = { nonce: async () => 0n, attestor: async () => '0x0000000000000000000000000000000000000000', liquidationRecord: async () => ({ lastLiquidatedAt: 0, liquidationCount: 0, shortfallCount: 0, totalShortfall: 0n }), onChainScore: async () => ({ score: 0, issuedAt: 0, expiresAt: 0, isStale: true }) }

const hypersync = new HyperSyncHistoryChecker({
  apiToken: process.env.ENVIO_API_TOKEN ?? '',
  ...(process.env.NO_HYPERSYNC ? { urlFor: () => 'http://127.0.0.1:9' } : {}),
})
const history: HistoryChecker = process.env.ALCHEMY_API_KEY
  ? new FallbackHistoryChecker(hypersync, new AlchemyHistorySource({ apiKey: process.env.ALCHEMY_API_KEY }))
  : hypersync

const inner = new LegacyChainScoreClient('https://chainscore.dev')
const asked: ChainSlug[] = []
const chainscore: ChainScoreClient = {
  score: (wallet: Address, chain: ChainSlug) => {
    asked.push(chain)
    return inner.score(wallet, chain)
  },
}

const svc = new AttestationService({ history, chainscore, registry: registry as never, signer: {} as never, store: new MemoryStore(), log: silentLogger, scoreTtlSeconds: 86400, submitWindowSeconds: 900 })
const r = await svc.evaluate(getAddress(process.argv[2]!), 'live-check')
console.log(JSON.stringify({ at: new Date().toISOString(), chainscoreQueried: asked, result: r }, null, 1))
