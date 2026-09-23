'use client'
import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Suspense } from 'react'
import { isAddress, type Address } from 'viem'
import { useAccount } from 'wagmi'
import { explorerTx } from '@/config/network'
import { gql, type LiquidationRow, type WalletEventRow } from '@/lib/indexer'
import { TERMS, scoreToTier, type Tier } from '@/lib/tiers'
import { pct, shortAddr, tokens, usd, when } from '@/lib/format'
import { useTenorState } from '@/hooks/useTenorState'
import { Badge } from '@/components/ui/badge'
import { Card, CardTitle, Label } from '@/components/ui/card'

const WAD = 10n ** 18n

export default function ActivityPage() {
  return (
    <Suspense fallback={<Card className="h-64" />}>
      <Activity />
    </Suspense>
  )
}

function Activity() {
  const params = useSearchParams()
  const { address } = useAccount()
  const q = params.get('wallet')
  const wallet = (q && isAddress(q) ? q : address) as Address | undefined
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-grotesk text-3xl font-bold">Activity</h1>
        <p className="mt-1 text-muted">
          History from the Envio indexer. Every Tenor liquidation is recorded on-chain against the wallet, together with the terms it
          happened under.
        </p>
      </div>
      {wallet ? <Loop wallet={wallet} /> : <Card className="h-32 text-muted">Connect a wallet, or open /activity?wallet=0x…, to see its loop.</Card>}
      <Feed />
    </div>
  )
}

interface WalletQuery {
  Wallet_by_pk: { liquidationCount: number; shortfallCount: number; totalShortfall: string; lastLiquidatedAt: string | null; latestScore: number | null } | null
  WalletEvent: WalletEventRow[]
}

function Loop({ wallet }: { wallet: Address }) {
  const s = useTenorState(wallet)
  const data = useQuery({
    queryKey: ['loop', wallet],
    refetchInterval: 5_000,
    queryFn: () =>
      gql<WalletQuery>(
        `query ($id: String!) {
          Wallet_by_pk(id: $id) { liquidationCount shortfallCount totalShortfall lastLiquidatedAt latestScore }
          WalletEvent(where: { wallet_id: { _eq: $id } }, order_by: [{ blockNumber: asc }, { logIndex: asc }]) {
            id kind blockNumber blockTimestamp logIndex txHash amount score tier maxLtvBps liqThresholdBps collateralPriceWad shortfall fromReserves socialized counterparty
          }
        }`,
        { id: wallet.toLowerCase() },
      ),
  })

  if (data.error) return <Card className="border-warning/50 text-sm">Indexer unavailable: {String((data.error as Error).message)}. Current position data on the Market page still works (it reads from chain).</Card>
  if (!data.data) return <Card className="h-64 animate-pulse" />
  const events = data.data.WalletEvent
  const liqIdx = events.findIndex((e) => e.kind === 'LIQUIDATED')
  const before = events.slice(0, liqIdx).filter((e) => e.kind === 'ATTESTED').at(-1)
  const after = events.slice(liqIdx).find((e) => e.kind === 'ATTESTED')
  const liq = liqIdx >= 0 ? events[liqIdx] : undefined

  return (
    <div className="space-y-4">
      {liq && (
        <LoopStrip
          before={before}
          liq={liq}
          after={after}
          // The collateral the wallet held going into the liquidation, valued at the
          // price recorded when it borrowed: same collateral, same price, only the tier differs.
          collateral={netCollateral(events.slice(0, liqIdx))}
          price={borrowPrice(events.slice(0, liqIdx))}
        />
      )}
      <Card>
        <div className="mb-3 flex items-center justify-between">
          <CardTitle>Timeline for {shortAddr(wallet)}</CardTitle>
          {data.data.Wallet_by_pk && (
            <span className="text-sm text-muted">
              {data.data.Wallet_by_pk.liquidationCount} Tenor liquidation(s), {data.data.Wallet_by_pk.shortfallCount} with shortfall
            </span>
          )}
        </div>
        {events.length === 0 ? (
          <p className="text-sm text-muted">No Tenor activity for this wallet yet.</p>
        ) : (
          <ol className="space-y-2">
            {events.map((e) => (
              <li key={e.id} className="grid grid-cols-[170px_1fr_auto] gap-3 border-t border-border pt-2 text-sm">
                <span className="text-xs text-muted">{when(BigInt(e.blockTimestamp))}</span>
                <span>{describe(e)}</span>
                <TxLink hash={e.txHash} />
              </li>
            ))}
          </ol>
        )}
      </Card>
    </div>
  )
}

/** The loop, readable at a glance. */
function LoopStrip({ before, liq, after, collateral, price }: { before?: WalletEventRow; liq: WalletEventRow; after?: WalletEventRow; collateral?: bigint; price?: bigint }) {
  const beforeTier = (before?.tier ?? liq.tier ?? 'FLOOR') as Tier
  const afterTier = after?.score != null ? scoreToTier(after.score) : ('FLOOR' as Tier)
  const capacity = (tier: Tier) => (collateral !== undefined && price ? (((collateral * price) / WAD) * BigInt(TERMS[tier].maxLtvBps)) / 10_000n : undefined)
  const steps = [
    { label: 'Liquidated on Tenor', value: `repaid ${tokens(BigInt(liq.amount ?? 0), 'tUSD', 2)}`, sub: BigInt(liq.shortfall ?? 0) > 0n ? `shortfall ${tokens(BigInt(liq.shortfall!), 'tUSD', 2)}` : 'no shortfall', tone: 'danger' },
    { label: 'Score invalidated', value: 'same transaction', sub: `tier ${beforeTier} → floor terms until re-attested`, tone: 'warning' },
    { label: 'New score', value: after?.score != null ? `${after.score} (tier ${afterTier})` : 'not yet re-attested', sub: after ? 'includes Tenor’s penalty and caps (itemized on Score)' : 'request one on the Score page', tone: 'accent' },
    {
      label: 'Same collateral now supports',
      value: capacity(afterTier) !== undefined ? tokens(capacity(afterTier), 'tUSD', 0) : `${pct(TERMS[afterTier].maxLtvBps)} LTV`,
      sub: capacity(beforeTier) !== undefined ? `was ${tokens(capacity(beforeTier), 'tUSD', 0)} at tier ${beforeTier} (${pct(TERMS[beforeTier].maxLtvBps)} → ${pct(TERMS[afterTier].maxLtvBps)} LTV)` : `was ${pct(TERMS[beforeTier].maxLtvBps)} LTV`,
      tone: 'success',
    },
  ] as const
  return (
    <Card>
      <Label className="mb-3">The feedback loop</Label>
      <div className="grid grid-cols-4 gap-3">
        {steps.map((st, i) => (
          <div key={st.label} className="relative rounded-md border border-border p-3">
            <Badge tone={st.tone}>{i + 1}</Badge>
            <div className="mt-2 text-xs text-muted">{st.label}</div>
            <div className="num mt-0.5 font-semibold">{st.value}</div>
            <div className="mt-0.5 text-xs text-muted">{st.sub}</div>
          </div>
        ))}
      </div>
      {collateral !== undefined && price !== undefined && (
        <p className="mt-2 text-xs text-muted">
          Capacity for the {tokens(collateral, 'tCOLL', 2)} held before the liquidation, at the {usd(price)} mock-oracle price recorded when it borrowed; per-wallet cap aside.
        </p>
      )}
    </Card>
  )
}

function netCollateral(events: WalletEventRow[]): bigint {
  return events.reduce((n, e) => (e.kind === 'COLLATERAL_IN' ? n + BigInt(e.amount ?? 0) : e.kind === 'COLLATERAL_OUT' ? n - BigInt(e.amount ?? 0) : n), 0n)
}

function borrowPrice(events: WalletEventRow[]): bigint | undefined {
  const b = events.filter((e) => e.kind === 'BORROWED').at(-1)
  return b?.collateralPriceWad ? BigInt(b.collateralPriceWad) : undefined
}

function describe(e: WalletEventRow): React.ReactNode {
  const amt = (sym: string) => tokens(BigInt(e.amount ?? 0), sym, 2)
  switch (e.kind) {
    case 'ATTESTED':
      return <>Score submitted on-chain: <b className="num">{e.score}</b> (tier {e.tier})</>
    case 'COLLATERAL_IN':
      return <>Deposited {amt('tCOLL')} collateral</>
    case 'COLLATERAL_OUT':
      return <>Withdrew {amt('tCOLL')} collateral</>
    case 'BORROWED':
      return <>Borrowed {amt('tUSD')} at tier {e.tier} (max LTV {pct(e.maxLtvBps ?? 0)}, liquidation at {pct(e.liqThresholdBps ?? 0)}), tCOLL at {usd(BigInt(e.collateralPriceWad ?? 0))} <Badge tone="warning">mock</Badge></>
    case 'REPAID':
      return <>Repaid {amt('tUSD')}</>
    case 'RETIERED':
      return <>Position re-priced to tier {e.tier}</>
    case 'BAD_DEBT':
      return <>Bad debt realized: {tokens(BigInt(e.shortfall ?? 0), 'tUSD', 2)} ({tokens(BigInt(e.fromReserves ?? 0), 'tUSD', 2)} from reserves, {tokens(BigInt(e.socialized ?? 0), 'tUSD', 2)} socialized to lenders)</>
    case 'LIQUIDATED':
      return <><b className="text-danger">Liquidated</b> by {shortAddr(e.counterparty ?? '')}: repaid {amt('tUSD')} at tier {e.tier} (liquidation at {pct(e.liqThresholdBps ?? 0)}), tCOLL at {usd(BigInt(e.collateralPriceWad ?? 0))} <Badge tone="warning">mock</Badge></>
    case 'LIQUIDATION_RECORDED':
      return <>Registry recorded the liquidation{BigInt(e.shortfall ?? 0) > 0n ? ` with ${tokens(BigInt(e.shortfall!), 'tUSD', 2)} shortfall` : ''}: <b>score invalidated</b></>
    default:
      return e.kind
  }
}

function TxLink({ hash }: { hash: string }) {
  const url = explorerTx(hash)
  return url ? (
    <a className="font-mono text-xs text-accent underline" href={url} target="_blank" rel="noreferrer">
      {hash.slice(0, 10)}…
    </a>
  ) : (
    <span className="font-mono text-xs text-muted">{hash.slice(0, 10)}…</span>
  )
}

interface FeedQuery {
  LiquidationEvent: LiquidationRow[]
  MarketTotals: Array<{ liquidationCount: number; liquidationsWithShortfall: number; badDebt: string; badDebtFromReserves: string; badDebtSocialized: string; borrowCount: number; attestationCount: number }>
}

function Feed() {
  const data = useQuery({
    queryKey: ['feed'],
    refetchInterval: 5_000,
    queryFn: () =>
      gql<FeedQuery>(`{
        LiquidationEvent(order_by: { blockNumber: desc }, limit: 25) {
          id wallet_id liquidator repaid collateralSeized shortfall fromReserves socialized score tier liqThresholdBps collateralPriceWad blockTimestamp txHash
        }
        MarketTotals { liquidationCount liquidationsWithShortfall badDebt badDebtFromReserves badDebtSocialized borrowCount attestationCount }
      }`),
  })
  const t = data.data?.MarketTotals[0]
  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <CardTitle>Liquidations</CardTitle>
        {t && (
          <span className="text-sm text-muted">
            {t.liquidationCount} total, {t.liquidationsWithShortfall} with shortfall; bad debt {tokens(BigInt(t.badDebt), 'tUSD', 2)} ({tokens(BigInt(t.badDebtFromReserves), 'tUSD', 2)} absorbed by reserves)
          </span>
        )}
      </div>
      {data.error ? (
        <p className="text-sm text-warning">Indexer unavailable: {String((data.error as Error).message)}</p>
      ) : !data.data ? (
        <div className="h-24 animate-pulse" />
      ) : data.data.LiquidationEvent.length === 0 ? (
        <p className="text-sm text-muted">No liquidations yet.</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted">
            <tr>
              <th className="py-1 font-normal">When</th>
              <th className="font-normal">Wallet</th>
              <th className="font-normal">Tier</th>
              <th className="font-normal">Repaid</th>
              <th className="font-normal">Shortfall</th>
              <th className="font-normal">Absorbed by</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.data.LiquidationEvent.map((l) => (
              <tr key={l.id} className="border-t border-border">
                <td className="py-1.5 text-xs text-muted">{when(BigInt(l.blockTimestamp))}</td>
                <td>
                  <Link className="font-mono text-accent underline" href={`/activity?wallet=${l.wallet_id}`}>
                    {shortAddr(l.wallet_id)}
                  </Link>
                </td>
                <td>{l.tier}</td>
                <td className="num">{tokens(BigInt(l.repaid), 'tUSD', 2)}</td>
                <td className="num">{BigInt(l.shortfall) > 0n ? tokens(BigInt(l.shortfall), 'tUSD', 2) : '—'}</td>
                <td className="text-xs text-muted">
                  {BigInt(l.shortfall) > 0n ? `reserves ${tokens(BigInt(l.fromReserves), 'tUSD', 2)}, lenders ${tokens(BigInt(l.socialized), 'tUSD', 2)}` : '—'}
                </td>
                <td>
                  <TxLink hash={l.txHash} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  )
}
