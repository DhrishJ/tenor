/**
 * Which chains and lending deployments Tenor checks for borrowing history.
 *
 * This mirrors ChainScore's own coverage (prior art: lib/data/coverage.generated.json
 * at commit a519058): Aave V3 on seven chains, Aave V2 and Compound V2 on
 * Ethereum. It must match: if Tenor looked at a deployment ChainScore does not
 * cover, every wallet that borrowed there would read as "ChainScore missed
 * borrowing history" and be refused.
 *
 * Addresses are not typed from memory:
 *  - Aave pools: bgd-labs/aave-address-book, commit 59e086fd3868 (src/ts/AaveV3*.ts,
 *    AaveV2Ethereum.ts, `POOL`). For Ethereum this is the core V3 market only.
 *  - Compound V2 cTokens: compound-finance/compound-config, commit ff8e979ffcb2
 *    (networks/mainnet.json, `cTokens`).
 *  - HyperSync endpoints: docs.envio.dev supported-networks table.
 */
import type { Address, Hex } from 'viem'

export type ChainSlug = 'ethereum' | 'arbitrum' | 'optimism' | 'polygon' | 'base' | 'avalanche' | 'scroll'

export interface CoveredChain {
  slug: ChainSlug
  /** Display name used in user-facing reasons ("Base data unavailable ..."). */
  name: string
  chainId: number
  aaveV3Pool: Address
  aaveV2Pool?: Address
  compoundV2CTokens?: readonly Address[]
}

/** keccak256("Borrow(address,address,address,uint256,uint8,uint256,uint16)"), aave-v3-core IPool.sol.
 *  onBehalfOf (the borrower) is the second indexed argument: topic2. */
export const AAVE_V3_BORROW_TOPIC: Hex = '0xb3d084820fb1a9decffb176436bd02558d15fac9b0ddfed8c465bc7359d7dce0'

/** keccak256("Borrow(address,address,address,uint256,uint256,uint256,uint16)"), protocol-v2 ILendingPool.sol.
 *  onBehalfOf is topic2 here too. */
export const AAVE_V2_BORROW_TOPIC: Hex = '0xc6a898309e823ee50bac64e45ca8adba6690e99e7841c45d754e2a38e9019d9b'

/** First four bytes of keccak256("borrow(uint256)"), the cToken borrow method.
 *  Compound V2's Borrow event does not index the borrower, so borrowing is
 *  detected from transactions the wallet sends to a cToken with this selector.
 *  KNOWN FALSE NEGATIVE: borrows made through a contract (DeFi Saver, Instadapp,
 *  a Safe) are invisible to this check. */
export const COMPOUND_BORROW_SIGHASH: Hex = '0xc5ebeaec'

const COMPOUND_V2_CTOKENS: readonly Address[] = [
  '0x7713DD9Ca933848F6819F38B8352D9A15EA73F67', // cFEI
  '0x041171993284df560249b57358f931d9eb7b925d', // cUSDP
  '0xe65cdb6479bac1e22340e4e755fae7e509ecd06c', // cAAVE
  '0x4b0181102a0112a2ef11abee5563bb4a3176c9d7', // cSUSHI
  '0x80a2ae356fc9ef4305676f7a3e2ed04e12c33946', // cYFI
  '0x12392f67bdf24fae0af363c24ac620a2f67dad86', // cTUSD
  '0xface851a4921ce59e912d19329929ce6da6eb0c7', // cLINK
  '0xccF4429DB6322D5C611ee964527D42E5d685DD6a', // cWBTC2
  '0x70e36f6bf80a52b3b46b3af8e106cc0ed743e8e4', // cCOMP
  '0x39AA39c021dfbaE8faC545936693aC917d5E7563', // cUSDC
  '0x5d3a536E4D6DbD6114cc1Ead35777bAB948E3643', // cDAI
  '0xf650C3d88D12dB855b8bf7D11Be6C55A4e07dCC9', // cUSDT
  '0x6C8c6b02E7b2BE14d4fA6022Dfd6d75921D90E4E', // cBAT
  '0x4Ddc2D193948926D02f9B1fE9e1daa0718270ED5', // cETH
  '0xF5DCe57282A584D2746FaF1593d3121Fcac444dC', // cSAI
  '0x158079Ee67Fce2f58472A96584A73C7Ab9AC95c1', // cREP
  '0xB3319f5D18Bc0D84dD1b4825Dcde5d5f7266d407', // cZRX
  '0xC11b1268C1A384e55C48c2391d8d480264A3A7F4', // cWBTC
  '0x35a18000230da775cac24873d00ff85bccded550', // cUNI
  '0x95b4eF2869eBD94BEb4eEE400a99824BF5DC325b', // cMKR
]

export const COVERED_CHAINS: readonly CoveredChain[] = [
  {
    slug: 'ethereum',
    name: 'Ethereum',
    chainId: 1,
    aaveV3Pool: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
    aaveV2Pool: '0x7d2768dE32b0b80b7a3454c06BdAc94A69DDc7A9',
    compoundV2CTokens: COMPOUND_V2_CTOKENS,
  },
  { slug: 'arbitrum', name: 'Arbitrum', chainId: 42161, aaveV3Pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD' },
  { slug: 'optimism', name: 'Optimism', chainId: 10, aaveV3Pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD' },
  { slug: 'polygon', name: 'Polygon', chainId: 137, aaveV3Pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD' },
  { slug: 'base', name: 'Base', chainId: 8453, aaveV3Pool: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5' },
  { slug: 'avalanche', name: 'Avalanche', chainId: 43114, aaveV3Pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD' },
  { slug: 'scroll', name: 'Scroll', chainId: 534352, aaveV3Pool: '0x11fCfe756c05AD438e312a7fd934381537D3cFfe' },
]

export function chainBySlug(slug: ChainSlug): CoveredChain {
  const c = COVERED_CHAINS.find((x) => x.slug === slug)
  if (!c) throw new Error(`unknown chain ${slug}`)
  return c
}
