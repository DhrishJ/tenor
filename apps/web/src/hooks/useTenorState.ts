'use client'
/**
 * Current state, read from the chain (OBJECTIONS P3-O4): one multicall per
 * refresh. The indexer is only used for history.
 */
import { useReadContracts } from 'wagmi'
import type { Address } from 'viem'
import { contracts } from '@/config/network'
import { MockERC20Abi, MockPriceOracleAbi, ScoreRegistryAbi, TenorMarketAbi } from '@/generated/abis'
import { tierFromIndex, type Tier } from '@/lib/tiers'

const ZERO = '0x0000000000000000000000000000000000000000' as Address

export interface TenorState {
  loading: boolean
  refetch: () => void
  market: {
    paused: boolean | undefined
    borrowRateBps: bigint | undefined
    totalAssets: bigint | undefined
    totalDebt: bigint | undefined
    reserves: bigint | undefined
    maxPriceAge: bigint | undefined
  }
  prices: {
    coll: { price: bigint; updatedAt: bigint } | undefined
    usd: { price: bigint; updatedAt: bigint } | undefined
  }
  position: { collateral: bigint; debt: bigint; tier: Tier; score: number } | undefined
  healthFactor: bigint | undefined
  healthFactorError: string | undefined
  maxBorrow: bigint | undefined
  maxBorrowError: string | undefined
  score: { score: number; issuedAt: bigint; expiresAt: bigint; isStale: boolean } | undefined
  effectiveTier: Tier | undefined
  liquidation: { lastLiquidatedAt: bigint; liquidationCount: number; shortfallCount: number; totalShortfall: bigint } | undefined
  balances: { usd: bigint; coll: bigint; usdAllowance: bigint; collAllowance: bigint; lpShares: bigint } | undefined
}

export function useTenorState(wallet: Address | undefined): TenorState {
  const w = wallet ?? ZERO
  const m = { address: contracts.market, abi: TenorMarketAbi } as const
  const r = { address: contracts.registry, abi: ScoreRegistryAbi } as const
  const o = { address: contracts.oracle, abi: MockPriceOracleAbi } as const
  const usd = { address: contracts.tUSD, abi: MockERC20Abi } as const
  const coll = { address: contracts.tCOLL, abi: MockERC20Abi } as const

  const q = useReadContracts({
    allowFailure: true,
    contracts: [
      { ...m, functionName: 'paused' },
      { ...m, functionName: 'borrowRateBps' },
      { ...m, functionName: 'totalAssets' },
      { ...m, functionName: 'totalDebt' },
      { ...m, functionName: 'reserves' },
      { ...m, functionName: 'maxPriceAge' },
      { ...o, functionName: 'getPrice', args: [contracts.tCOLL] },
      { ...o, functionName: 'getPrice', args: [contracts.tUSD] },
      { ...m, functionName: 'getPosition', args: [w] },
      { ...m, functionName: 'healthFactor', args: [w] },
      { ...m, functionName: 'maxBorrow', args: [w] },
      { ...r, functionName: 'getScore', args: [w] },
      { ...r, functionName: 'effectiveTier', args: [w] },
      { ...r, functionName: 'getLiquidationRecord', args: [w] },
      { ...usd, functionName: 'balanceOf', args: [w] },
      { ...coll, functionName: 'balanceOf', args: [w] },
      { ...usd, functionName: 'allowance', args: [w, contracts.market] },
      { ...coll, functionName: 'allowance', args: [w, contracts.market] },
      { ...m, functionName: 'balanceOf', args: [w] },
    ],
    // Health factor and prices must never go stale on screen, even in a background tab.
    query: { refetchInterval: 4_000, refetchIntervalInBackground: true },
  })

  const d = q.data
  const ok = <T,>(i: number): T | undefined => (d?.[i]?.status === 'success' ? (d[i]!.result as T) : undefined)
  const err = (i: number) => (d?.[i]?.status === 'failure' ? (d[i]!.error as Error).message : undefined)
  const price = (i: number) => {
    const p = ok<readonly [bigint, bigint]>(i)
    return p ? { price: p[0], updatedAt: p[1] } : undefined
  }
  const pos = ok<readonly [bigint, bigint, number, number]>(8)
  const sc = ok<readonly [number, bigint, bigint, boolean]>(11)
  const eff = ok<readonly [number, number]>(12)
  const liq = ok<{ lastLiquidatedAt: bigint; liquidationCount: number; shortfallCount: number; totalShortfall: bigint }>(13)
  const hasWallet = Boolean(wallet)

  return {
    loading: q.isLoading,
    refetch: () => void q.refetch(),
    market: {
      paused: ok<boolean>(0),
      borrowRateBps: ok<bigint>(1),
      totalAssets: ok<bigint>(2),
      totalDebt: ok<bigint>(3),
      reserves: ok<bigint>(4),
      maxPriceAge: ok<bigint>(5),
    },
    prices: { coll: price(6), usd: price(7) },
    position: hasWallet && pos ? { collateral: pos[0], debt: pos[1], tier: tierFromIndex(pos[2]), score: Number(pos[3]) } : undefined,
    healthFactor: hasWallet ? ok<bigint>(9) : undefined,
    healthFactorError: hasWallet ? err(9) : undefined,
    maxBorrow: hasWallet ? ok<bigint>(10) : undefined,
    maxBorrowError: hasWallet ? err(10) : undefined,
    score: hasWallet && sc ? { score: Number(sc[0]), issuedAt: sc[1], expiresAt: sc[2], isStale: sc[3] } : undefined,
    effectiveTier: hasWallet && eff ? tierFromIndex(eff[0]) : undefined,
    liquidation: hasWallet && liq ? { ...liq, liquidationCount: Number(liq.liquidationCount), shortfallCount: Number(liq.shortfallCount) } : undefined,
    balances:
      hasWallet && ok<bigint>(14) !== undefined
        ? {
            usd: ok<bigint>(14)!,
            coll: ok<bigint>(15) ?? 0n,
            usdAllowance: ok<bigint>(16) ?? 0n,
            collAllowance: ok<bigint>(17) ?? 0n,
            lpShares: ok<bigint>(18) ?? 0n,
          }
        : undefined,
  }
}
