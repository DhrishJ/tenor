'use client'
import Link from 'next/link'
import type { Evaluation, Scored } from '@/lib/attestor'
import { Badge } from '@/components/ui/badge'
import { Card, CardTitle, Label } from '@/components/ui/card'
import { TERMS, type Tier } from '@/lib/tiers'
import { pct, tokens } from '@/lib/format'

/** One tier's terms, as the contract applies them. */
export function TierTerms({ tier }: { tier: Tier }) {
  const t = TERMS[tier]
  return (
    <div className="grid grid-cols-3 gap-4 text-sm">
      <div>
        <Label>Max LTV</Label>
        <div className="num text-lg">{pct(t.maxLtvBps)}</div>
      </div>
      <div>
        <Label>Liquidation at</Label>
        <div className="num text-lg">{pct(t.ltBps)}</div>
      </div>
      <div>
        <Label>Per-wallet cap</Label>
        <div className="num text-lg">{tokens(t.walletCap, 'tUSD', 0)}</div>
      </div>
    </div>
  )
}

/** Which number came from the model and which from Tenor policy. */
export function Itemization({ ev }: { ev: Scored }) {
  return (
    <div className="space-y-1.5 text-sm">
      <Row
        left={
          <>
            ChainScore score <Badge tone="accent">model</Badge>
          </>
        }
        right={<span className="num">{ev.chainscoreScore}</span>}
        note={`${ev.aggregation.description}. From the ChainScore API (prior art), model ${ev.modelVersion}.`}
      />
      {ev.adjustments.map((a) => (
        <Row
          key={a.rule}
          left={
            <>
              Tenor adjustment <Badge tone="warning">policy</Badge>
            </>
          }
          right={<span className="num text-warning">{a.points}</span>}
          note={a.detail}
        />
      ))}
      {ev.policyCaps.map((c) => (
        <Row
          key={c.rule}
          left={
            <>
              Tenor cap: at most tier {c.maxTier} ({c.maxScore}) <Badge tone="warning">policy cap</Badge>
            </>
          }
          right={<span className={c.binding ? 'num text-warning' : 'num text-muted'}>{c.binding ? 'applied' : 'not binding'}</span>}
          note={c.detail}
        />
      ))}
      <div className="flex items-center justify-between border-t border-border pt-2 font-medium">
        <span>Tenor score (the number that gets signed)</span>
        <span className="num text-lg">{ev.tenorScore}</span>
      </div>
    </div>
  )
}

function Row({ left, right, note }: { left: React.ReactNode; right: React.ReactNode; note: string }) {
  return (
    <div>
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2">{left}</span>
        {right}
      </div>
      <div className="text-xs text-muted">{note}</div>
    </div>
  )
}

export function Chains({ ev, fixture = false }: { ev: Scored; fixture?: boolean }) {
  return (
    <div className="space-y-3 text-sm">
      <div className="flex items-center gap-2">
        <Label>Borrowing history by chain</Label>
        {fixture ? (
          <Badge tone="warning">recorded fixture, not live</Badge>
        ) : ev.history.verification === 'full' ? (
          <Badge tone="success">independently verified</Badge>
        ) : (
          <Badge tone="warning">partially verified</Badge>
        )}
      </div>
      <table className="w-full">
        <thead className="text-left text-xs text-muted">
          <tr>
            <th className="py-1 font-normal">Chain</th>
            <th className="font-normal">ChainScore score</th>
            <th className="font-normal">Borrows found</th>
            <th className="font-normal">Verified by</th>
          </tr>
        </thead>
        <tbody>
          {ev.contributingChains.map((c) => (
            <tr key={c.chain} className="border-t border-border">
              <td className="py-1.5">{c.name}</td>
              <td className="num">{c.chainscoreScore}</td>
              <td className="num">{c.verifiedBy === 'chainscore-only' ? '—' : c.aaveBorrows + c.compoundBorrows}</td>
              <td>
                {c.verifiedBy === 'chainscore-only' ? (
                  <Badge tone="warning">ChainScore only (unverified)</Badge>
                ) : (
                  <Badge tone={fixture ? 'warning' : 'success'}>
                    {fixture ? 'recorded ' : ''}
                    {c.verifiedBy === 'hypersync' ? 'HyperSync' : 'Alchemy (fallback)'}
                  </Badge>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-xs text-muted">
        The ChainScore score above is the <b>minimum</b> across these chains: a conservative heuristic chosen by Tenor. ChainScore’s
        model scores one chain at a time and was never validated on a cross-chain combination.
      </p>
      {ev.excludedChains.length > 0 && (
        <details className="text-xs text-muted">
          <summary className="cursor-pointer">Excluded chains ({ev.excludedChains.length})</summary>
          <ul className="mt-1 space-y-0.5">
            {ev.excludedChains.map((c) => (
              <li key={c.chain}>
                <b className="text-text">{c.name}</b>: {c.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

/** UNAVAILABLE and INSUFFICIENT_HISTORY: never rendered like a low score. */
export function NotScored({ ev }: { ev: Exclude<Evaluation, { state: 'SCORED' }> }) {
  const unavailable = ev.state === 'UNAVAILABLE'
  const notes = unavailable ? ev.chains : ev.excludedChains
  return (
    <Card className={unavailable ? 'border-warning/50' : ''}>
      <div className="flex items-center gap-3">
        <CardTitle>{unavailable ? 'Score unavailable (not a low score)' : 'No borrowing history found'}</CardTitle>
        <Badge tone={unavailable ? 'warning' : 'neutral'}>{ev.state}</Badge>
      </div>
      <p className="mt-2 text-sm">{ev.reason}</p>
      {unavailable && notes.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm">
          {notes.map((c) => (
            <li key={c.chain} className="flex gap-2">
              <span className="font-medium text-warning">{c.name}</span>
              <span className="text-muted">{c.reason}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4 rounded-md border border-border bg-background/50 p-3 text-sm">
        No score means no signature, <b>not</b> no access: this wallet can still borrow today at floor terms (60% max LTV).{' '}
        <Link href="/market" className="text-accent underline">
          Go to the market
        </Link>
      </div>
    </Card>
  )
}
