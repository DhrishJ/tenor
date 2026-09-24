// Live check of the Alchemy fallback history source against one wallet.
// Usage: ALCHEMY_API_KEY=... tsx scripts/probe-alchemy.ts <address>
import { AlchemyHistorySource } from '../src/history.js'
const key = process.env.ALCHEMY_API_KEY
if (!key) throw new Error('ALCHEMY_API_KEY not set')
const t = Date.now()
const res = await new AlchemyHistorySource({ apiKey: key }).check(process.argv[2] as `0x${string}`)
for (const [chain, r] of Object.entries(res)) console.log(chain.padEnd(10), JSON.stringify(r))
console.log(`${Date.now() - t} ms`)
