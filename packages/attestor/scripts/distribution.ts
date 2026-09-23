// Distribution check through the REAL pipeline (live HyperSync + live
// ChainScore + Tenor's validation and minimum rule). Display-only: no signing.
// Usage: ENVIO_API_TOKEN=... tsx scripts/distribution.ts <addresses.json> <out.jsonl>
import { appendFileSync, readFileSync } from 'node:fs'
import { getAddress } from 'viem'
import { HyperSyncHistoryChecker } from '../src/history.js'
import { LegacyChainScoreClient } from '../src/chainscore.js'
import { AttestationService } from '../src/service.js'
import { MemoryStore } from '../src/store.js'
import { silentLogger } from '../src/log.js'

const noLiquidations = {
  nonce: async () => 0n,
  attestor: async () => '0x0000000000000000000000000000000000000000' as const,
  liquidationRecord: async () => ({ lastLiquidatedAt: 0, liquidationCount: 0, shortfallCount: 0, totalShortfall: 0n }),
  onChainScore: async () => ({ score: 0, issuedAt: 0, expiresAt: 0, isStale: true }),
}
const svc = new AttestationService({
  history: new HyperSyncHistoryChecker({ apiToken: process.env.ENVIO_API_TOKEN! }),
  chainscore: new LegacyChainScoreClient('https://chainscore.dev'),
  registry: noLiquidations,
  signer: {} as never, // evaluate() never signs
  store: new MemoryStore(),
  log: silentLogger,
  scoreTtlSeconds: 86_400,
  submitWindowSeconds: 900,
})
const addrs: string[] = JSON.parse(readFileSync(process.argv[2]!, 'utf8'))
for (const a of addrs) {
  const r = await svc.evaluate(getAddress(a), 'distribution')
  appendFileSync(process.argv[3]!, JSON.stringify({ address: a, ...r }) + '\n')
  await new Promise((res) => setTimeout(res, 6_000)) // stay under ChainScore's 20/min
}
console.log('done')
