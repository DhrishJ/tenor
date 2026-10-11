// TEST, for the demo video: what Tenor's policy does to a score after a Tenor
// liquidation, run through the real AttestationService with the same fake
// inputs as test/service.test.ts ("shortfall: capped at 451"). No network,
// no real wallet: ChainScore, history and the registry are fakes.
//
//   npx tsx scripts/demo-policy.ts
import { FakeChainScore, FakeHistory, FakeRegistry, WALLET, NOW_MS, goodUpstream, makeService, withBorrows } from '../test/fakes.js'

const line = (s = '') => console.log(s)

async function run(title: string, record: { liquidationCount: number; shortfallCount: number; totalShortfall: bigint }) {
  const registry = new FakeRegistry()
  registry.record = { lastLiquidatedAt: NOW_MS / 1000 - 3600, ...record }
  const t = makeService({
    registry,
    history: new FakeHistory(withBorrows({ arbitrum: 3 })),
    chainscore: new FakeChainScore({ arbitrum: goodUpstream({ score: 800 }) }),
  })
  const r = await t.service.evaluate(WALLET, 'demo')
  if (r.state !== 'SCORED') throw new Error(r.state)
  line(`── ${title}`)
  line(`   ChainScore (model)                   ${r.chainscoreScore}`)
  let running = r.chainscoreScore
  for (const a of r.adjustments) {
    running += a.points
    line(`   ${a.points > 0 ? '+' : ''}${a.points} ${a.rule.padEnd(32)} ${running}`)
  }
  for (const c of r.policyCaps) {
    line(`   cap ${c.rule.padEnd(30)} ≤ ${c.maxScore} (tier ${c.maxTier})${c.binding ? '  binding' : ''}`)
  }
  line(`   Tenor score                          ${r.tenorScore}  → tier ${r.tier}`)
  line()
}

line('TEST: Tenor policy after a Tenor liquidation (fake inputs, same as the unit tests)')
line()
await run('liquidated, no bad debt', { liquidationCount: 1, shortfallCount: 0, totalShortfall: 0n })
await run('liquidated, collateral did not cover the debt (shortfall)', { liquidationCount: 1, shortfallCount: 1, totalShortfall: 5n })
