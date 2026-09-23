/**
 * End-to-end check against the contracts deployed by contracts/script/Deploy.s.sol
 * on a LOCAL Monad-mode anvil (deployments/31337.json). No second deployment path.
 *
 * Live: ChainScore (the real API), the deployed ScoreRegistry/TenorMarket,
 * real EIP-712 signatures verified by the contract.
 *
 * LOCAL ONLY: the scored wallet is a public mainnet borrower that this script
 * does not control. Its on-chain actions here (borrow, get liquidated) are
 * sent through anvil account impersonation. That is only possible on a local
 * node and must never be shown as a real signature in the demo.
 *
 * Env: RPC_URL, DEPLOYER_KEY, ATTESTOR_KEY (local throwaways), HISTORY=live|fixture,
 *      ENVIO_API_TOKEN (live history), CHAINSCORE_BASE_URL.
 */
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  parseAbi,
  parseEther,
  type Address,
  type Hex,
} from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { LegacyChainScoreClient } from '../src/chainscore.js'
import { COVERED_CHAINS, type ChainSlug } from '../src/coverage.js'
import { HyperSyncHistoryChecker, type ChainHistory, type HistoryChecker } from '../src/history.js'
import { createApp } from '../src/http.js'
import { silentLogger } from '../src/log.js'
import { registryAbi, ViemRegistryReader } from '../src/registry.js'
import { AttestationService, type AttestResult, type SerializedAttestation } from '../src/service.js'
import { AttestationSigner } from '../src/signer.js'
import { MemoryStore } from '../src/store.js'
import { TIER_INDEX, scoreToTier } from '../src/tiers.js'

const SUBJECT = getAddress('0x04383b40611ee9408cb6fb8a6bb0d66b07ca7e09') // public Arbitrum Aave borrower
const env = (k: string) => {
  const v = process.env[k]
  if (!v) throw new Error(`${k} not set`)
  return v
}
const rpcUrl = env('RPC_URL')
const dep = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../deployments/31337.json'), 'utf8'))
const registry = getAddress(dep.scoreRegistry)
const market = getAddress(dep.tenorMarket)
const oracle = getAddress(dep.mockPriceOracle)
const tUSD = getAddress(dep.tUSD)
const tCOLL = getAddress(dep.tCOLL)

const pub = createPublicClient({ transport: http(rpcUrl) })
const chainId = await pub.getChainId()
const chain = { id: chainId, name: 'anvil-monad', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } } as const
const deployer = createWalletClient({ chain, transport: http(rpcUrl), account: privateKeyToAccount(env('DEPLOYER_KEY') as Hex) })

const marketAbi = parseAbi([
  'function depositCollateral(uint256)',
  'function borrow(uint256)',
  'function maxBorrow(address) view returns (uint256)',
  'function liquidate(address,uint256) returns (uint256,uint256)',
  'function getPosition(address) view returns (uint256,uint256,uint8,uint16)',
  'function healthFactor(address) view returns (uint256)',
])
const erc20Abi = parseAbi(['function approve(address,uint256) returns (bool)', 'function faucet()', 'function balanceOf(address) view returns (uint256)'])
const oracleAbi = parseAbi(['function setPrice(address,uint256)'])

let failures = 0
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`)
  if (!ok) failures++
}
const section = (s: string) => console.log(`\n=== ${s} ===`)

// ------------------------------------------------------------------ history
class FixtureHistory implements HistoryChecker {
  async check() {
    const r = Object.fromEntries(COVERED_CHAINS.map((c) => [c.slug, { ok: true, aaveBorrows: 0, compoundBorrows: 0 }])) as Record<ChainSlug, ChainHistory>
    return r
  }
}
class SubjectFixtureHistory implements HistoryChecker {
  // Observed live via HyperSync on 2026-09-22 22:07 CDT: 3 Aave V3 Borrow logs on
  // Arbitrum (pool 0x794a...14aD). Other chains were NOT checked before HyperSync
  // became unreachable; they are assumed 0 here and that assumption is printed.
  async check(wallet: Address) {
    const r = await new FixtureHistory().check()
    if (wallet === SUBJECT) r.arbitrum = { ok: true, aaveBorrows: 3, compoundBorrows: 0 }
    return r
  }
}
const historyMode = process.env.HISTORY ?? 'live'
const history: HistoryChecker =
  historyMode === 'live' ? new HyperSyncHistoryChecker({ apiToken: env('ENVIO_API_TOKEN') }) : new SubjectFixtureHistory()

// ------------------------------------------------------------------ service
function makeService(chainscoreBaseUrl: string) {
  const signer = new AttestationSigner(env('ATTESTOR_KEY') as Hex, {
    name: dep.eip712Name,
    version: dep.eip712Version,
    chainId,
    verifyingContract: registry,
  })
  const store = new MemoryStore()
  const service = new AttestationService({
    history,
    chainscore: new LegacyChainScoreClient(chainscoreBaseUrl),
    registry: new ViemRegistryReader(pub, registry),
    signer,
    store,
    log: silentLogger,
    scoreTtlSeconds: 86_400,
    submitWindowSeconds: 900,
  })
  const app = createApp({ service, store, log: silentLogger, health: [], rateLimitPerIp: 100, rateLimitPerAddress: 100 })
  return { service, store, signer, app }
}

async function attestHttp(app: ReturnType<typeof createApp>, wallet: Address): Promise<AttestResult & { requestId: string }> {
  const res = await app.request('/attest', { method: 'POST', body: JSON.stringify({ address: wallet }) })
  return res.json()
}

const toStruct = (a: SerializedAttestation) => ({
  wallet: a.wallet,
  score: a.score,
  issuedAt: BigInt(a.issuedAt),
  expiresAt: BigInt(a.expiresAt),
  deadline: BigInt(a.deadline),
  nonce: BigInt(a.nonce),
  modelVersion: a.modelVersion,
})

async function submit(a: SerializedAttestation, sig: Hex) {
  const hash = await deployer.writeContract({ address: registry, abi: registryAbi, functionName: 'submitAttestation', args: [toStruct(a), sig] })
  return pub.waitForTransactionReceipt({ hash })
}

async function simulateSubmit(a: SerializedAttestation, sig: Hex): Promise<string> {
  try {
    await pub.simulateContract({ address: registry, abi: registryAbi, functionName: 'submitAttestation', args: [toStruct(a), sig], account: deployer.account })
    return 'accepted'
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e)
    return m.match(/Error: (\w+\([^)]*\))/)?.[1] ?? m.split('\n').slice(0, 2).join(' ')
  }
}

// ================================================================== run
console.log(`chain ${chainId} (local Monad-mode anvil), registry ${registry}, market ${market}`)
console.log(
  historyMode === 'live'
    ? 'HISTORY SOURCE: LIVE HyperSync'
    : 'HISTORY SOURCE: FIXTURE. HyperSync was unreachable (TLS rejected) during this run. Subject = 3 Aave V3 borrows on Arbitrum, observed live via HyperSync at 22:07 CDT; other chains NOT verified, assumed 0.',
)
console.log(`CHAINSCORE: LIVE ${env('CHAINSCORE_BASE_URL')}`)

const main = makeService(env('CHAINSCORE_BASE_URL'))
check('service signer matches registry attestor', (await pub.readContract({ address: registry, abi: registryAbi, functionName: 'attestor' })) === main.signer.address)

// ---------------------------------------------------------------- state 1
section('State INSUFFICIENT_HISTORY: fresh wallet')
const fresh = privateKeyToAccount(generatePrivateKey()).address
const r1 = await attestHttp(main.app, fresh)
console.log(JSON.stringify({ state: r1.state, reason: 'reason' in r1 ? r1.reason : undefined }))
check('fresh wallet -> INSUFFICIENT_HISTORY, no signature', r1.state === 'INSUFFICIENT_HISTORY' && !('signature' in r1))

// ---------------------------------------------------------------- state 2
section('State UNAVAILABLE: forced failure (ChainScore pointed at a dead endpoint)')
const dead = makeService('http://127.0.0.1:9')
const r2 = await attestHttp(dead.app, SUBJECT)
console.log(JSON.stringify({ state: r2.state, reason: 'reason' in r2 ? r2.reason : undefined }))
check('dead upstream -> UNAVAILABLE, no signature', r2.state === 'UNAVAILABLE' && !('signature' in r2))
const refusals = (await (await dead.app.request('/refusals')).json()) as { refusals: unknown[] }
check('refusal is logged and queryable at /refusals', refusals.refusals.length === 1, JSON.stringify(refusals.refusals[0]))

const deadHistorySvc = new AttestationService({
  history: new HyperSyncHistoryChecker({ apiToken: 'x', urlFor: () => 'http://127.0.0.1:9', timeoutMs: 2_000 }),
  chainscore: new LegacyChainScoreClient(env('CHAINSCORE_BASE_URL')),
  registry: new ViemRegistryReader(pub, registry),
  signer: main.signer,
  store: new MemoryStore(),
  log: silentLogger,
  scoreTtlSeconds: 86_400,
  submitWindowSeconds: 900,
})
const r2b = await deadHistorySvc.attest(SUBJECT, 'forced-history')
console.log(JSON.stringify({ state: r2b.state, reason: 'reason' in r2b ? r2b.reason : undefined }))
check('dead history source -> UNAVAILABLE naming every chain, no signature', r2b.state === 'UNAVAILABLE' && r2b.chains.length === 7 && !('signature' in r2b))

// ---------------------------------------------------------------- state 3
section('State SCORED: real borrower, live ChainScore, concurrent requests')
const concurrent = await Promise.all(Array.from({ length: 5 }, () => attestHttp(main.app, SUBJECT)))
const r3 = concurrent[0]!
if (r3.state !== 'SCORED' || !r3.signature || !r3.attestation) {
  console.log(JSON.stringify(r3, null, 1))
  check('subject wallet SCORED', false)
  console.log(`\n${failures} failure(s)`)
  process.exit(1)
}
const { signature: _s, ...shown } = r3
console.log(JSON.stringify({ ...shown, attestation: { ...r3.attestation } }, null, 1))
console.log(`signature: ${r3.signature.slice(0, 10)}... (truncated)`)
check('SCORED with signature', true, `ChainScore ${r3.chainscoreScore} -> Tenor ${r3.tenorScore} (${r3.tier})`)
check('5 concurrent requests -> one signature on one nonce', new Set(concurrent.map((r) => ('signature' in r ? r.signature : null))).size === 1)

// Tampered payload: rejected by the deployed contract, not just locally.
const tampered = { ...r3.attestation, score: r3.attestation.score === 850 ? 849 : r3.attestation.score + 1 }
check('tampered score rejected by deployed registry', (await simulateSubmit(tampered, r3.signature)).includes('InvalidSigner'), await simulateSubmit(tampered, r3.signature))

await submit(r3.attestation, r3.signature)
const [score, , , stale] = await pub.readContract({ address: registry, abi: registryAbi, functionName: 'getScore', args: [SUBJECT] })
const [tierIdx] = await pub.readContract({ address: registry, abi: registryAbi, functionName: 'effectiveTier', args: [SUBJECT] })
check('submitted and read back from registry', score === r3.tenorScore && !stale, `score ${score}, stale ${stale}`)
check('off-chain tier mirror == on-chain effectiveTier', tierIdx === TIER_INDEX[scoreToTier(score)], `tier index ${tierIdx}`)

// ---------------------------------------------------------------- loop
section('Liquidation feedback loop (LOCAL ONLY: subject actions via anvil impersonation)')
await pub.request({ method: 'anvil_impersonateAccount' as never, params: [SUBJECT] as never })
await pub.request({ method: 'anvil_setBalance' as never, params: [SUBJECT, '0x8AC7230489E80000'] as never })
const subject = createWalletClient({ chain, transport: http(rpcUrl), account: SUBJECT })
const send = async (p: Parameters<typeof subject.writeContract>[0]) => pub.waitForTransactionReceipt({ hash: await subject.writeContract(p) })

await send({ address: tCOLL, abi: erc20Abi, functionName: 'faucet', account: SUBJECT, chain })
await send({ address: tCOLL, abi: erc20Abi, functionName: 'approve', args: [market, parseEther('500')], account: SUBJECT, chain })
await send({ address: market, abi: marketAbi, functionName: 'depositCollateral', args: [parseEther('500')], account: SUBJECT, chain })
const maxBefore = await pub.readContract({ address: market, abi: marketAbi, functionName: 'maxBorrow', args: [SUBJECT] })
await send({ address: market, abi: marketAbi, functionName: 'borrow', args: [maxBefore], account: SUBJECT, chain })
console.log(`borrowed ${Number(maxBefore) / 1e18} tUSD against 500 tCOLL ($1,000) at tier ${r3.tier}`)

// A second attestation, signed BEFORE the liquidation and not yet submitted.
await main.store.deleteChainScores(SUBJECT) // fetch newer data so it is not "already on-chain"
await new Promise((r) => setTimeout(r, 1500))
const preSigned = await attestHttp(main.app, SUBJECT)
check('pre-liquidation attestation signed (unsubmitted)', preSigned.state === 'SCORED' && !!preSigned.signature)

// Gap the price through the buffer and liquidate: collateral $2 -> $0.80.
await new Promise((r) => setTimeout(r, 1500))
await pub.waitForTransactionReceipt({ hash: await deployer.writeContract({ address: oracle, abi: oracleAbi, functionName: 'setPrice', args: [tCOLL, parseEther('0.8')] }) })
const liquidator = createWalletClient({ chain, transport: http(rpcUrl), account: privateKeyToAccount(generatePrivateKey()) })
await pub.request({ method: 'anvil_setBalance' as never, params: [liquidator.account.address, '0x8AC7230489E80000'] as never })
await pub.waitForTransactionReceipt({ hash: await liquidator.writeContract({ address: tUSD, abi: erc20Abi, functionName: 'faucet' }) })
await pub.waitForTransactionReceipt({ hash: await liquidator.writeContract({ address: tUSD, abi: erc20Abi, functionName: 'approve', args: [market, parseEther('1000')] }) })
await pub.waitForTransactionReceipt({ hash: await liquidator.writeContract({ address: market, abi: marketAbi, functionName: 'liquidate', args: [SUBJECT, parseEther('1000')] }) })
const rec = await pub.readContract({ address: registry, abi: registryAbi, functionName: 'getLiquidationRecord', args: [SUBJECT] })
console.log(`registry record: liquidations ${rec.liquidationCount}, shortfalls ${rec.shortfallCount}, totalShortfall ${Number(rec.totalShortfall) / 1e18} tUSD`)
check('liquidation recorded with shortfall', rec.liquidationCount === 1 && rec.shortfallCount === 1)
const [, , , staleAfter] = await pub.readContract({ address: registry, abi: registryAbi, functionName: 'getScore', args: [SUBJECT] })
check('old score invalidated on-chain immediately', staleAfter)

if (preSigned.state === 'SCORED' && preSigned.attestation && preSigned.signature) {
  const why = await simulateSubmit(preSigned.attestation, preSigned.signature)
  check('pre-liquidation attestation rejected by deployed registry', why.includes('IssuedBeforeLiquidation'), why)
}

await new Promise((r) => setTimeout(r, 1500))
const post = await attestHttp(main.app, SUBJECT)
if (post.state !== 'SCORED' || !post.attestation || !post.signature) {
  console.log(JSON.stringify(post, null, 1))
  check('post-liquidation attestation issued', false)
} else {
  console.log(JSON.stringify({ chainscoreScore: post.chainscoreScore, adjustments: post.adjustments, tenorScore: post.tenorScore, tier: post.tier, issuedAt: post.issuedAt, lastLiquidatedAt: Number(rec.lastLiquidatedAt) }, null, 1))
  check('new attestation is from data computed after the liquidation', post.issuedAt > Number(rec.lastLiquidatedAt))
  check('Tenor adjustment itemized and applied', post.adjustments.length > 0 && post.tenorScore < post.chainscoreScore)
  check('new, penalized attestation accepted by deployed registry', (await simulateSubmit(post.attestation, post.signature)) === 'accepted')
  await submit(post.attestation, post.signature)
  const [tierAfter] = await pub.readContract({ address: registry, abi: registryAbi, functionName: 'effectiveTier', args: [SUBJECT] })
  await pub.waitForTransactionReceipt({ hash: await deployer.writeContract({ address: oracle, abi: oracleAbi, functionName: 'setPrice', args: [tCOLL, parseEther('2')] }) })
  // Re-post the same 500 tCOLL (the first 500 were seized in the liquidation).
  await send({ address: tCOLL, abi: erc20Abi, functionName: 'approve', args: [market, parseEther('500')], account: SUBJECT, chain })
  await send({ address: market, abi: marketAbi, functionName: 'depositCollateral', args: [parseEther('500')], account: SUBJECT, chain })
  const [collNow] = await pub.readContract({ address: market, abi: marketAbi, functionName: 'getPosition', args: [SUBJECT] })
  check('position again holds exactly 500 tCOLL', collNow === parseEther('500'))
  const maxAfter = await pub.readContract({ address: market, abi: marketAbi, functionName: 'maxBorrow', args: [SUBJECT] })
  console.log(`tier index before ${tierIdx} -> after ${tierAfter}; with the same 500 tCOLL, max borrow ${Number(maxBefore) / 1e18} -> ${Number(maxAfter) / 1e18} tUSD`)
  check('same collateral now supports less', maxAfter < maxBefore)
}
await pub.request({ method: 'anvil_stopImpersonatingAccount' as never, params: [SUBJECT] as never })

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
