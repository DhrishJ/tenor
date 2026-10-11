// Phase 5 §3: the adversarial pass on a LIVE chain, against the REHEARSAL
// deployment (never the final one: it leaves a liquidation and test scores).
//
// - Attestation rejections are eth_call simulations of submitAttestation
//   against live state: free, and the revert names are the contract's own.
// - Market checks and the liquidation loop are real transactions from two
//   throwaway wallets (ADV_BORROWER, ADV_LIQUIDATOR), funded by the deployer.
// - The stale-score check needs a scored wallet we control. No wallet we
//   control has borrowing history, so it uses a TEST ATTESTATION signed
//   directly with the attestor key (score 800, 90-second lifetime), bound to
//   the rehearsal registry by EIP-712 and labelled as such in the output.
//
// Usage (from packages/attestor, keys from the repo-root .env):
//   CHAIN_ID=10143 RPC_URL=https://testnet-rpc.monad.xyz tsx scripts/adversarial-testnet.ts
//   (RPC_URL=alchemy uses Alchemy's Monad testnet endpoint with ALCHEMY_API_KEY)
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  keccak256,
  parseEther,
  toHex,
  type Abi,
  type Address,
  type Hex,
} from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { attestationTypes } from '../src/signer.js'

const root = resolve(import.meta.dirname, '../../..')
const env = Object.fromEntries(
  readFileSync(resolve(root, '.env'), 'utf8')
    .split('\n')
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
) as Record<string, string>
const chainId = Number(process.env.CHAIN_ID)
const rpcUrl = process.env.RPC_URL === 'alchemy' ? `https://monad-testnet.g.alchemy.com/v2/${env.ALCHEMY_API_KEY}` : process.env.RPC_URL!
const dep = JSON.parse(readFileSync(resolve(root, `deployments/${chainId}.json`), 'utf8'))
const abi = (n: string) => JSON.parse(readFileSync(resolve(root, `apps/web/abis/${n}.json`), 'utf8')) as Abi
const A = { registry: getAddress(dep.scoreRegistry), market: getAddress(dep.tenorMarket), oracle: getAddress(dep.mockPriceOracle), usd: getAddress(dep.tUSD), coll: getAddress(dep.tCOLL) }
const ABI = { registry: abi('ScoreRegistry'), market: abi('TenorMarket'), oracle: abi('MockPriceOracle'), erc20: abi('MockERC20') }

const chain = defineChain({ id: chainId, name: `chain-${chainId}`, nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } })
// Public testnet RPCs rate-limit bursts: retry with backoff.
const transport = () => http(rpcUrl, { retryCount: 8, retryDelay: 1_500, timeout: 30_000 })
const pub = createPublicClient({ chain, transport: transport() })
const acct = (k: string) => privateKeyToAccount(env[k] as Hex)
const deployer = acct('DEPLOYER_PRIVATE_KEY')
const keeper = acct('ORACLE_KEEPER_PRIVATE_KEY')
const attestor = acct('ATTESTOR_PRIVATE_KEY')
const borrower = acct('ADV_BORROWER_PRIVATE_KEY')
const liquidator = acct('ADV_LIQUIDATOR_PRIVATE_KEY')
const wallet = (a: ReturnType<typeof acct>) => createWalletClient({ account: a, chain, transport: transport() })
const TEST_MODEL = keccak256(toHex('TEST: manual adversarial attestation, rehearsal deployment only'))
const DEMO_RELAYED = getAddress('0x0a1187b46f6cf98a11811d60f891f56e3e5dbf6a') // nonce already used on the rehearsal registry (2026-09-24)

type Row = { id: string; check: string; expected: string; observed: string; pass: boolean; tx?: string[]; note?: string }
const rows: Row[] = []
function record(r: Row) {
  rows.push(r)
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id.padEnd(4)} ${r.check} | expected ${r.expected} | observed ${r.observed}${r.tx?.length ? ` | tx ${r.tx.join(', ')}` : ''}`)
}
const errName = (e: unknown) => {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError)
    if (r instanceof ContractFunctionRevertedError) return r.data?.errorName ?? r.shortMessage
    return e.shortMessage
  }
  return String(e)
}
const isRevert = (e: unknown) => e instanceof BaseError && e.walk((x) => x instanceof ContractFunctionRevertedError) instanceof ContractFunctionRevertedError
async function expectRevert(id: string, check: string, expected: string, run: () => Promise<unknown>) {
  for (let attempt = 1; ; attempt++) {
    try {
      await run()
      record({ id, check, expected, observed: 'did not revert', pass: false })
      return
    } catch (e) {
      // An RPC failure is not a test result: retry it, never record it as one.
      if (!isRevert(e) && attempt < 5) {
        await sleep(3_000 * attempt)
        continue
      }
      const n = errName(e)
      record({ id, check, expected, observed: isRevert(e) ? n : `RPC error after retries: ${n}`, pass: n === expected })
      return
    }
  }
}
async function send(a: ReturnType<typeof acct>, address: Address, contractAbi: Abi, functionName: string, args: unknown[] = []) {
  // 30% + 30k headroom over the estimate: a plain estimate ran out of gas once
  // on testnet (see apps/web/src/lib/gas.ts).
  const est = await pub.estimateContractGas({ address, abi: contractAbi, functionName, args, account: a } as never)
  const hash = await wallet(a).writeContract({ address, abi: contractAbi, functionName, args, gas: (est * 130n) / 100n + 30_000n } as never)
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 })
  if (r.status !== 'success') throw new Error(`${functionName} reverted: ${hash}`)
  return hash
}
const read = <T,>(address: Address, contractAbi: Abi, functionName: string, args: unknown[] = []) =>
  pub.readContract({ address, abi: contractAbi, functionName, args } as never) as Promise<T>
const now = async () => Number((await pub.getBlock()).timestamp)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type Att = { wallet: Address; score: number; issuedAt: bigint; expiresAt: bigint; deadline: bigint; nonce: bigint; modelVersion: Hex }
const domain = { name: dep.eip712Name, version: dep.eip712Version, chainId, verifyingContract: A.registry }
const sign = (a: Att, key: Hex = env.ATTESTOR_PRIVATE_KEY as Hex, d: typeof domain = domain) =>
  privateKeyToAccount(key).signTypedData({ domain: d, types: attestationTypes, primaryType: 'ScoreAttestation', message: a })
const simulateSubmit = (a: Att, sig: Hex) =>
  pub.simulateContract({ address: A.registry, abi: ABI.registry, functionName: 'submitAttestation', args: [a, sig], account: borrower.address } as never)

const PHASES = (process.env.PHASES ?? 'A,B,C,D,E').split(',')
const phase = (p: string) => PHASES.includes(p)

async function main() {
  console.log(`rehearsal registry ${A.registry}, market ${A.market}, chain ${chainId}`)
  if (getAddress(await read<Address>(A.registry, ABI.registry, 'attestor')) !== attestor.address) throw new Error('attestor key does not match registry')

  // ---- fund the two throwaway wallets (gas only)
  for (const w of [borrower, liquidator]) {
    if ((await pub.getBalance({ address: w.address })) < parseEther('0.1')) {
      const hash = await wallet(deployer).sendTransaction({ to: w.address, value: parseEther('0.3') })
      await pub.waitForTransactionReceipt({ hash })
      console.log(`funded ${w.address} with 0.3 MON: ${hash}`)
    }
  }

  const t = await now()
  const nonce = await read<bigint>(A.registry, ABI.registry, 'nonces', [borrower.address])
  const base: Att = { wallet: borrower.address, score: 800, issuedAt: BigInt(t - 10), expiresAt: BigInt(t + 3600), deadline: BigInt(t + 900), nonce, modelVersion: TEST_MODEL }
  // ---- A. attestation rejections (simulated against live state)
  if (phase('A')) {
  try {
    await simulateSubmit(base, await sign(base))
    record({ id: 'A0', check: 'control: a correctly signed attestation', expected: 'accepted', observed: 'accepted (simulation)', pass: true })
  } catch (e) {
    record({ id: 'A0', check: 'control: a correctly signed attestation', expected: 'accepted', observed: errName(e), pass: false })
  }
  const expired = { ...base, issuedAt: BigInt(t - 7200), expiresAt: BigInt(t - 60) }
  await expectRevert('A1', 'expired attestation', 'AttestationExpired', async () => simulateSubmit(expired, await sign(expired)))
  const relayedNonce = await read<bigint>(A.registry, ABI.registry, 'nonces', [DEMO_RELAYED])
  const replay = { ...base, wallet: DEMO_RELAYED, nonce: relayedNonce - 1n }
  await expectRevert('A2', `replayed nonce (${DEMO_RELAYED.slice(0, 8)}…, nonce ${relayedNonce - 1n} already used)`, 'InvalidNonce', async () => simulateSubmit(replay, await sign(replay)))
  await expectRevert('A3', 'signed by an unauthorized key', 'InvalidSigner', async () => simulateSubmit(base, await sign(base, generatePrivateKey())))
  await expectRevert('A4', 'signed for the wrong chain id (1)', 'InvalidSigner', async () => simulateSubmit(base, await sign(base, undefined, { ...domain, chainId: 1 })))
  await expectRevert('A5', 'signed for the wrong verifying contract (the market)', 'InvalidSigner', async () =>
    simulateSubmit(base, await sign(base, undefined, { ...domain, verifyingContract: A.market })),
  )
  const late = { ...base, deadline: BigInt(t - 1) }
  await expectRevert('A6', 'submit deadline passed', 'DeadlinePassed', async () => simulateSubmit(late, await sign(late)))
  const future = { ...base, issuedAt: BigInt(t + 3600), expiresAt: BigInt(t + 7200) }
  await expectRevert('A7', 'issued in the future (beyond 60 s skew)', 'IssuedInFuture', async () => simulateSubmit(future, await sign(future)))
  const longTtl = { ...base, expiresAt: base.issuedAt + 3n * 86_400n }
  await expectRevert('A8', 'lifetime over the 48 h maximum', 'TtlTooLong', async () => simulateSubmit(longTtl, await sign(longTtl)))
  }

  // ---- B. market: unscored wallet at floor terms (real transactions)
  const coll = parseEther('1000') // $2,000 at the $2.00 mock price
  if (phase('B')) {
  const txB: string[] = []
  if ((await read<bigint>(A.coll, ABI.erc20, 'balanceOf', [borrower.address])) < coll) txB.push(await send(borrower, A.coll, ABI.erc20, 'faucet'))
  txB.push(await send(borrower, A.coll, ABI.erc20, 'approve', [A.market, coll]))
  txB.push(await send(borrower, A.market, ABI.market, 'depositCollateral', [coll]))
  const [tierIdx] = await read<readonly [number, number]>(A.registry, ABI.registry, 'effectiveTier', [borrower.address])
  const max = await read<bigint>(A.market, ABI.market, 'maxBorrow', [borrower.address])
  record({ id: 'B1', check: 'unscored wallet is priced at FLOOR', expected: 'tier 0 (FLOOR)', observed: `tier ${tierIdx}; maxBorrow ${Number(max) / 1e18} tUSD for $2,000 collateral`, pass: tierIdx === 0, tx: txB })
  // maxBorrow is deliberately ~3 wei under the true limit (index/RAY + 2, a
  // rounding margin), so "maxBorrow + 1 wei" is NOT the boundary. The true
  // limit here is FLOOR's 1,000 tUSD wallet cap; one wei over it must revert.
  const cap = parseEther('1000')
  record({ id: 'B2a', check: 'maxBorrow sits just under the true limit', expected: 'cap - maxBorrow = a few wei', observed: `${cap - max} wei under the 1,000 tUSD cap`, pass: cap - max > 0n && cap - max < 10n })
  await expectRevert('B2', 'borrow the true limit + 1 wei (1,000 tUSD cap + 1 wei)', 'ExceedsWalletCap', async () =>
    pub.simulateContract({ address: A.market, abi: ABI.market, functionName: 'borrow', args: [cap + 1n], account: borrower.address } as never),
  )
  const hB3 = await send(borrower, A.market, ABI.market, 'borrow', [max])
  record({ id: 'B3', check: 'unscored wallet borrows exactly maxBorrow at floor terms', expected: 'success', observed: 'success', pass: true, tx: [hB3] })
  }

  // ---- C. pause: borrow and liquidation revert, repay and withdraw still work
  let hUnpause = ''
  if (phase('C')) {
  const hPause = await send(deployer, A.market, ABI.market, 'pause')
  await expectRevert('C1', 'borrow while paused', 'EnforcedPause', async () =>
    pub.simulateContract({ address: A.market, abi: ABI.market, functionName: 'borrow', args: [1n], account: borrower.address } as never),
  )
  await expectRevert('C2', 'liquidate while paused', 'EnforcedPause', async () =>
    pub.simulateContract({ address: A.market, abi: ABI.market, functionName: 'liquidate', args: [borrower.address, 1n], account: liquidator.address } as never),
  )
  const hApprove = await send(borrower, A.usd, ABI.erc20, 'approve', [A.market, parseEther('1')])
  const hRepay = await send(borrower, A.market, ABI.market, 'repay', [borrower.address, parseEther('1')])
  const hWithdraw = await send(borrower, A.market, ABI.market, 'withdrawCollateral', [parseEther('1')])
  record({ id: 'C3', check: 'repay and withdrawCollateral while paused', expected: 'both succeed', observed: 'both succeeded', pass: true, tx: [hPause, hApprove, hRepay, hWithdraw] })
  hUnpause = await send(deployer, A.market, ABI.market, 'unpause')
  }

  // ---- D. stale score prices at FLOOR (TEST ATTESTATION, 90 s lifetime)
  if (phase('D')) {
  const t2 = await now()
  const n2 = await read<bigint>(A.registry, ABI.registry, 'nonces', [borrower.address])
  const test: Att = { wallet: borrower.address, score: 800, issuedAt: BigInt(t2 - 5), expiresAt: BigInt(t2 + 90), deadline: BigInt(t2 + 600), nonce: n2, modelVersion: TEST_MODEL }
  const hTest = await send(borrower, A.registry, ABI.registry, 'submitAttestation', [test, await sign(test)])
  const [freshTier] = await read<readonly [number, number]>(A.registry, ABI.registry, 'effectiveTier', [borrower.address])
  const freshMax = await read<bigint>(A.market, ABI.market, 'maxBorrow', [borrower.address])
  record({ id: 'D1', check: 'TEST attestation (score 800) accepted; tier while fresh', expected: 'tier 4 (A)', observed: `tier ${freshTier}; maxBorrow now ${(Number(freshMax) / 1e18).toFixed(2)} tUSD`, pass: freshTier === 4, tx: [hUnpause, hTest] })
  while ((await now()) <= t2 + 92) await sleep(5_000)
  const [staleTier] = await read<readonly [number, number]>(A.registry, ABI.registry, 'effectiveTier', [borrower.address])
  const staleMax = await read<bigint>(A.market, ABI.market, 'maxBorrow', [borrower.address])
  record({ id: 'D2', check: 'after expiry the same wallet is priced at FLOOR', expected: 'tier 0 (FLOOR)', observed: `tier ${staleTier}; maxBorrow ${(Number(staleMax) / 1e18).toFixed(4)} tUSD`, pass: staleTier === 0 })
  await expectRevert('D3', 'expired score: borrow above floor terms (100 tUSD)', 'ExceedsWalletCap', async () =>
    pub.simulateContract({ address: A.market, abi: ABI.market, functionName: 'borrow', args: [parseEther('100')], account: borrower.address } as never),
  )
  // Half the floor headroom: maxBorrow is stale within a block once the wallet
  // has debt (interest accrues every 0.4 s), so "exactly max" is not the test.
  const small = staleMax / 2n
  if (small > 0n) {
    const hSmall = await send(borrower, A.market, ABI.market, 'borrow', [small])
    record({ id: 'D4', check: 'expired score: borrow within floor terms', expected: 'success', observed: `borrowed ${(Number(small) / 1e18).toFixed(4)} tUSD`, pass: true, tx: [hSmall] })
  } else {
    record({ id: 'D4', check: 'expired score: borrow within floor terms', expected: 'success', observed: 'no floor headroom left to test', pass: false })
  }
  }

  // ---- E. the loop: price gap, liquidation by a second wallet, registry records it
  if (phase('E')) {
  const test = { wallet: borrower.address, score: 800, modelVersion: TEST_MODEL }
  const debtBefore = await read<bigint>(A.market, ABI.market, 'debtOf', [borrower.address])
  const txE: string[] = []
  txE.push(await send(keeper, A.oracle, ABI.oracle, 'setPrice', [A.coll, parseEther('1.4')]))
  const hf = await read<bigint>(A.market, ABI.market, 'healthFactor', [borrower.address])
  if ((await read<bigint>(A.usd, ABI.erc20, 'balanceOf', [liquidator.address])) < parseEther('1000')) txE.push(await send(liquidator, A.usd, ABI.erc20, 'faucet'))
  txE.push(await send(liquidator, A.usd, ABI.erc20, 'approve', [A.market, parseEther('1000')]))
  const hLiq = await send(liquidator, A.market, ABI.market, 'liquidate', [borrower.address, parseEther('1000')])
  txE.push(hLiq)
  const rec = await read<{ lastLiquidatedAt: bigint; liquidationCount: number; shortfallCount: number; totalShortfall: bigint }>(A.registry, ABI.registry, 'getLiquidationRecord', [borrower.address])
  const [, , , isStale] = await read<readonly [number, bigint, bigint, boolean]>(A.registry, ABI.registry, 'getScore', [borrower.address])
  txE.push(await send(keeper, A.oracle, ABI.oracle, 'setPrice', [A.coll, parseEther('2')]))
  record({
    id: 'E1',
    check: 'mock price $2.00 → $1.40; second wallet liquidates; registry records it',
    expected: 'HF < 1, liquidation succeeds, liquidationCount 1, score stale',
    observed: `HF ${(Number(hf) / 1e18).toFixed(3)} before; debt ${(Number(debtBefore) / 1e18).toFixed(2)}; liquidationCount ${rec.liquidationCount}, shortfallCount ${rec.shortfallCount}, score stale ${isStale}; price restored to $2.00`,
    pass: hf < 10n ** 18n && Number(rec.liquidationCount) >= 1 && isStale,
    tx: txE,
  })
  const pre = { ...test, issuedAt: BigInt(Number(rec.lastLiquidatedAt) - 1), expiresAt: BigInt(Number(rec.lastLiquidatedAt) + 3000), deadline: BigInt((await now()) + 600), nonce: await read<bigint>(A.registry, ABI.registry, 'nonces', [borrower.address]) }
  await expectRevert('E2', 'a score computed before the liquidation is refused', 'IssuedBeforeLiquidation', async () => simulateSubmit(pre, await sign(pre)))
  }

  const out = resolve(root, `docs/adversarial/testnet-pass-${new Date().toISOString().slice(0, 10)}-${PHASES.join('')}.json`)
  writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), chainId, deployment: 'rehearsal', registry: A.registry, market: A.market, borrower: borrower.address, liquidator: liquidator.address, testModelVersion: TEST_MODEL, rows }, null, 1))
  console.log(`\n${rows.filter((r) => r.pass).length}/${rows.length} passed. Written to ${out}`)
}

main().catch((e) => {
  console.error('ABORTED:', errName(e))
  process.exit(1)
})
