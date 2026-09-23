// Copies the event ABIs of the deployed contracts from the Foundry build
// artifacts, so the indexer can never drift from the Solidity source.
// Run `forge build` in ../contracts first.
import { readFileSync, writeFileSync } from 'node:fs'
const out = new URL('../../contracts/out/', import.meta.url)
for (const name of ['ScoreRegistry', 'TenorMarket']) {
  const { abi } = JSON.parse(readFileSync(new URL(`${name}.sol/${name}.json`, out), 'utf8'))
  writeFileSync(new URL(`../abis/${name}.json`, import.meta.url), JSON.stringify(abi.filter((x) => x.type === 'event'), null, 1) + '\n')
  console.log(name, abi.filter((x) => x.type === 'event').map((e) => e.name).join(', '))
}
