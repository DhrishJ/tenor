// Live check of the independent history checker against one wallet.
// Usage: tsx scripts/probe-history.ts <address>
import { HyperSyncHistoryChecker } from '../src/history.js'
const token = process.env.ENVIO_API_TOKEN
if (!token) throw new Error('ENVIO_API_TOKEN not set')
const wallet = process.argv[2] as `0x${string}`
const t = Date.now()
const res = await new HyperSyncHistoryChecker({ apiToken: token }).check(wallet)
console.log(JSON.stringify(res, null, 1), `\n${Date.now() - t} ms`)
