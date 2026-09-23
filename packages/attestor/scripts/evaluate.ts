// Display-only live evaluation of one wallet (no signing, no chain writes).
// Usage: ENVIO_API_TOKEN=... tsx scripts/evaluate.ts <address>
import { getAddress } from 'viem'
import { HyperSyncHistoryChecker } from '../src/history.js'
import { LegacyChainScoreClient } from '../src/chainscore.js'
import { AttestationService } from '../src/service.js'
import { MemoryStore } from '../src/store.js'
import { silentLogger } from '../src/log.js'
const registry = { nonce: async () => 0n, attestor: async () => '0x0000000000000000000000000000000000000000', liquidationRecord: async () => ({ lastLiquidatedAt: 0, liquidationCount: 0, shortfallCount: 0, totalShortfall: 0n }), onChainScore: async () => ({ score: 0, issuedAt: 0, expiresAt: 0, isStale: true }) }
const svc = new AttestationService({ history: new HyperSyncHistoryChecker({ apiToken: process.env.ENVIO_API_TOKEN! }), chainscore: new LegacyChainScoreClient('https://chainscore.dev'), registry: registry as never, signer: {} as never, store: new MemoryStore(), log: silentLogger, scoreTtlSeconds: 86400, submitWindowSeconds: 900 })
const r = await svc.evaluate(getAddress(process.argv[2]!), 'live-check')
console.log(JSON.stringify(r, null, 1))
