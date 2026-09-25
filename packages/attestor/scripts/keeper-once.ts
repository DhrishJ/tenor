// One manual keeper run: re-stamps the mock oracle's prices with the keeper
// key and prints price freshness before and after. For operations and for
// checking the keeper works on a new deployment; the service runs the same
// step daily on its own.
// Usage: CHAIN_ID=10143 RPC_URL=... ORACLE_KEEPER_PRIVATE_KEY=... tsx scripts/keeper-once.ts
import { createPublicClient, getAddress, http, type Hex } from 'viem'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { oracleFreshnessCheck, restampStep } from '../src/keeper.js'

const chainId = Number(process.env.CHAIN_ID)
const rpcUrl = process.env.RPC_URL!
const dep = JSON.parse(readFileSync(resolve(import.meta.dirname, `../../../deployments/${chainId}.json`), 'utf8'))
const client = createPublicClient({ transport: http(rpcUrl) })
const oracle = getAddress(dep.mockPriceOracle)
const tUSD = getAddress(dep.tUSD)
const tCOLL = getAddress(dep.tCOLL)
const fresh = oracleFreshnessCheck({
  client,
  oracle,
  assets: [
    { symbol: 'tUSD', address: tUSD },
    { symbol: 'tCOLL', address: tCOLL },
  ],
  maxPriceAgeSec: dep.maxPriceAge,
  keeperIntervalMs: 86_400_000,
})
console.log('before:', (await fresh.check()).detail)
const step = restampStep({ client, rpcUrl, chainId, keeperKey: process.env.ORACLE_KEEPER_PRIVATE_KEY as Hex, oracle, assets: [tUSD, tCOLL] })
console.log('restamp:', await step.run())
console.log('after:', (await fresh.check()).detail)
