'use client'
import { useQuery } from '@tanstack/react-query'
import { Suspense, useState } from 'react'
import { parseEther } from 'viem'
import { useViewedWallet } from '@/hooks/useViewedWallet'
import { getScore } from '@/lib/attestor'
import { useTenorState } from '@/hooks/useTenorState'
import { TERMS, TIERS, type Tier } from '@/lib/tiers'
import { pct, shortAddr, tokens, usd } from '@/lib/format'
import { Badge } from '@/components/ui/badge'
import { Card, CardTitle, Label, PageHeader } from '@/components/ui/card'
import { TokenIcon } from '@/components/ui/token'
import { Slider } from '@/components/ui/slider'
import { cn } from '@/lib/utils'

const WAD = 10n ** 18n
const BPS = 10_000n

/** Same arithmetic as TenorMarket: debt <= collateral value x maxLTV, and <= the tier's per-wallet cap. */
function terms(tier: Tier, collateral: bigint, price: bigint) {
  const t = TERMS[tier]
  const value = (collateral * price) / WAD
  const ltvLimit = (value * BigInt(t.maxLtvBps)) / BPS
  const capLimit = t.walletCap
  const borrow = ltvLimit < capLimit ? ltvLimit : capLimit
  return { ...t, value, ltvLimit, capLimit, borrow, binding: ltvLimit <= capLimit ? ('LTV' as const) : ('cap' as const) }
}

export default function ComparePage() {
  return (
    <Suspense fallback={<Card className="h-64" />}>
      <Compare />
    </Suspense>
  )
}

function Compare() {
  const { wallet: address, viewing } = useViewedWallet()
  const s = useTenorState(address)
  // Read-only view: the tier comes from the live score for that address (its
  // on-chain score may have expired; it cannot borrow from here anyway).
  const live = useQuery({
    queryKey: ['score', address],
    queryFn: () => getScore(address!),
    enabled: viewing && Boolean(address),
    staleTime: 60_000,
    retry: false,
  })
  const liveTier = live.data?.state === 'SCORED' ? live.data.tier : undefined
  // Default: 800 tCOLL. At the $2.00 mock price that is $1,600, below the level
  // where FLOOR's 1,000 tUSD wallet cap binds, so the difference is pure LTV.
  const [amount, setAmount] = useState(800)
  const [pick, setPick] = useState<Tier>('A')

  const price = s.prices.coll?.price
  const walletTier = viewing ? liveTier : s.effectiveTier
  const scored = walletTier !== undefined && walletTier !== 'FLOOR'
  const left: Tier = scored ? walletTier : pick
  const collateral = parseEther(String(amount))
  const a = price ? terms(left, collateral, price) : undefined
  const b = price ? terms('FLOOR', collateral, price) : undefined
  const diff = a && b ? a.borrow - b.borrow : undefined

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Side by side" title="Same collateral. Same rate. More credit.">
        {viewing
          ? 'The same hypothetical collateral, priced at this address’s live tier and at floor terms. It has posted nothing on Tenor.'
          : 'Identical collateral posted by a scored wallet and by an unscored one.'}
      </PageHeader>

      <Card className="grid items-center gap-8 md:grid-cols-[1.2fr_1fr_1fr]">
        <div>
          <Label>{viewing ? 'Hypothetical collateral, same for both' : 'Collateral posted by both wallets'}</Label>
          <div className="mt-1 flex items-center gap-2">
            <TokenIcon symbol="tCOLL" className="h-7 w-7" />
            <span className="num text-2xl font-semibold">{tokens(collateral, 'tCOLL', 0)}</span>
          </div>
          <Slider className="mt-3" min={100} max={5000} step={50} value={[amount]} onValueChange={([v]) => setAmount(v ?? amount)} />
        </div>
        <div>
          <Label>Collateral value</Label>
          <div className="num mt-1 text-2xl font-semibold">{a ? usd(a.value) : '—'}</div>
          <div className="mt-1 text-xs text-muted">
            tCOLL at {price ? usd(price) : '—'} <Badge tone="warning">mock oracle</Badge>
          </div>
        </div>
        <div className="rounded-xl bg-success/[0.06] p-4 text-right">
          <Label>Borrow difference</Label>
          <div className="num mt-1 text-4xl font-semibold tracking-tight text-success">{diff !== undefined ? `+${tokens(diff, 'tUSD', 0)}` : '—'}</div>
          <div className="text-xs text-muted">
            tier {left} vs unscored, from the same {tokens(collateral, 'tCOLL', 0)}
          </div>
        </div>
      </Card>

      {a && b && (
        <Card className="space-y-3">
          <Label>Borrowing capacity from the same collateral</Label>
          {[
            { name: scored ? (viewing && address ? `Real borrower ${shortAddr(address)} · tier ${left}` : `Your wallet · tier ${left}`) : `Tier ${left} (illustration)`, v: a.borrow, cls: 'bg-gradient-to-r from-accent to-[#3B82F6]' },
            { name: 'Unscored wallet · floor', v: b.borrow, cls: 'bg-slate-400' },
          ].map((row) => (
            <div key={row.name}>
              <div className="mb-1 flex justify-between text-sm">
                <span className="font-medium">{row.name}</span>
                <span className="num">{tokens(row.v, 'tUSD', 0)}</span>
              </div>
              <div className="h-3 overflow-hidden rounded-full bg-subtle">
                <div className={cn('h-full rounded-full transition-all', row.cls)} style={{ width: `${a.borrow > 0n ? Math.max(2, Number((row.v * 1000n) / (a.borrow > b.borrow ? a.borrow : b.borrow)) / 10) : 0}%` }} />
              </div>
            </div>
          ))}
        </Card>
      )}

      <div className="grid gap-6 md:grid-cols-2">
        <Side
          title={scored ? (viewing && address ? `Real borrower ${shortAddr(address)}` : 'Your wallet') : `A tier-${left} wallet`}
          badge={
            scored ? (
              <Badge tone="accent">{viewing ? `tier ${left} (live score, ${live.data?.state === 'SCORED' ? live.data.tenorScore : ''})` : `tier ${left} (from your on-chain score)`}</Badge>
            ) : (
              <span className="flex items-center gap-2">
                <Badge tone="neutral">illustration</Badge>
                <select
                  className="rounded border border-border bg-background px-2 py-0.5 text-xs"
                  value={pick}
                  onChange={(e) => setPick(e.target.value as Tier)}
                  aria-label="Tier to illustrate"
                >
                  {TIERS.filter((t) => t !== 'FLOOR').map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
              </span>
            )
          }
          t={a}
        />
        <Side title="Unscored wallet" badge={<Badge tone="neutral">floor tier</Badge>} t={b} />
      </div>

      <Card className="bg-subtle text-sm leading-relaxed shadow-none">
        <b>Why the interest rate is the same for both.</b> In a collateralized market the rate compensates lenders for expected loss,
        and the LTV controls how much loss is possible. A liquidation that lands before collateral falls below debt costs the lender
        nothing; a sudden price gap can leave a shortfall, absorbed by reserves first and then by lenders, and higher tiers have thinner
        buffers. The score governs collateral, not price. Current rate for every borrower:{' '}
        <span className="num">{s.market.borrowRateBps !== undefined ? pct(s.market.borrowRateBps, 2) : '—'}</span> APR.
      </Card>
      <p className="text-xs text-muted">
        Per-wallet limits only. Actual borrowing is also bounded by the tier’s and market’s total caps and by idle liquidity; the
        Market page’s Max button uses the contract’s maxBorrow, which includes all of them.
      </p>
    </div>
  )
}

function Side({ title, badge, t }: { title: string; badge: React.ReactNode; t: ReturnType<typeof terms> | undefined }) {
  return (
    <Card className="space-y-4">
      <div className="flex items-center justify-between">
        <CardTitle>{title}</CardTitle>
        {badge}
      </div>
      <div>
        <Label>Can borrow</Label>
        <div className="num mt-1 text-3xl font-semibold tracking-tight">{t ? tokens(t.borrow, 'tUSD', 0) : '—'}</div>
      </div>
      <dl className="grid grid-cols-2 gap-y-2.5 rounded-xl bg-subtle p-4 text-sm">
        <dt className="text-muted">Max LTV</dt>
        <dd className="num text-right">{t ? pct(t.maxLtvBps) : '—'}</dd>
        <dt className="text-muted">Liquidation threshold</dt>
        <dd className="num text-right">{t ? pct(t.ltBps) : '—'}</dd>
        <dt className={cn('text-muted', t?.binding === 'LTV' && 'text-text')}>
          LTV limit {t?.binding === 'LTV' && <Badge tone="accent">binding</Badge>}
        </dt>
        <dd className="num text-right">{t ? tokens(t.ltvLimit, 'tUSD', 0) : '—'}</dd>
        <dt className={cn('text-muted', t?.binding === 'cap' && 'text-text')}>
          Per-wallet cap {t?.binding === 'cap' && <Badge tone="warning">binding</Badge>}
        </dt>
        <dd className="num text-right">{t ? tokens(t.capLimit, 'tUSD', 0) : '—'}</dd>
      </dl>
    </Card>
  )
}
