/**
 * The network and every contract address come from configuration:
 * NEXT_PUBLIC_* env vars for the chain, and deployments/<chainId>.json (copied
 * by scripts/prebuild.mjs) for addresses. No literal lives in components.
 */
import { defineChain, getAddress, type Address } from 'viem'
import deployment from '@/generated/deployment.json'

function env(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is not set (see apps/web/.env.example)`)
  return value
}

// Next.js inlines NEXT_PUBLIC_* only for literal property access.
const chainId = Number(env('NEXT_PUBLIC_CHAIN_ID', process.env.NEXT_PUBLIC_CHAIN_ID))
const rpcUrl = env('NEXT_PUBLIC_RPC_URL', process.env.NEXT_PUBLIC_RPC_URL)
const explorerUrl = process.env.NEXT_PUBLIC_EXPLORER_URL ?? ''

if (deployment.chainId !== chainId) {
  throw new Error(`deployment.json is for chain ${deployment.chainId}, NEXT_PUBLIC_CHAIN_ID is ${chainId}`)
}

export const tenorChain = defineChain({
  id: chainId,
  name: process.env.NEXT_PUBLIC_CHAIN_NAME ?? `Chain ${chainId}`,
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
  ...(explorerUrl ? { blockExplorers: { default: { name: 'Explorer', url: explorerUrl } } } : {}),
  testnet: true,
})

export const contracts = {
  registry: getAddress(deployment.scoreRegistry),
  market: getAddress(deployment.tenorMarket),
  oracle: getAddress(deployment.mockPriceOracle),
  tUSD: getAddress(deployment.tUSD),
  tCOLL: getAddress(deployment.tCOLL),
} satisfies Record<string, Address>

export const services = {
  attestor: process.env.NEXT_PUBLIC_ATTESTOR_URL ?? '',
  indexer: process.env.NEXT_PUBLIC_INDEXER_URL ?? '',
  indexerDevSecret: process.env.NEXT_PUBLIC_INDEXER_DEV_SECRET ?? '',
}

export const devWallet = (process.env.NEXT_PUBLIC_DEV_WALLET || undefined) as Address | undefined

export function explorerTx(hash: string) {
  return explorerUrl ? `${explorerUrl.replace(/\/$/, '')}/tx/${hash}` : undefined
}
export function explorerAddress(a: string) {
  return explorerUrl ? `${explorerUrl.replace(/\/$/, '')}/address/${a}` : undefined
}
