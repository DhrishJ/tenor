import { TERMS, TIERS, type Tier } from '@/lib/tiers'
import { pct, tokens } from '@/lib/format'
import { cn } from '@/lib/utils'

/** The five tiers exactly as RiskParams.sol applies them. Same interest rate for every tier. */
export function TierLadder({ current }: { current?: Tier }) {
  const rows = [...TIERS].reverse()
  return (
    <div className="space-y-2">
      {rows.map((t) => {
        const terms = TERMS[t]
        const active = current === t
        return (
          <div
            key={t}
            className={cn(
              'grid grid-cols-[64px_1fr_92px] items-center gap-3 rounded-xl border px-3 py-2.5 transition-colors',
              active ? 'border-accent/40 bg-accent/[0.05]' : 'border-transparent hover:bg-subtle',
            )}
          >
            <div>
              <div className={cn('font-grotesk text-sm font-bold', t === 'FLOOR' ? 'text-muted' : 'text-text')}>{t === 'FLOOR' ? 'Floor' : `Tier ${t}`}</div>
              <div className="text-[10px] text-muted">{t === 'FLOOR' ? 'no score / ≤451' : terms.scores}</div>
            </div>
            <div>
              <div className="flex items-center justify-between text-[11px] text-muted">
                <span>
                  Max LTV <b className="num text-text">{pct(terms.maxLtvBps)}</b>
                </span>
                <span>liq. at {pct(terms.ltBps)}</span>
              </div>
              <div className="mt-1 h-2 overflow-hidden rounded-full bg-subtle">
                <div
                  className={cn('h-full rounded-full', t === 'FLOOR' ? 'bg-slate-400' : 'bg-gradient-to-r from-accent to-[#3B82F6]')}
                  style={{ width: `${(terms.maxLtvBps / 8000) * 100}%` }}
                />
              </div>
            </div>
            <div className="text-right">
              <div className="num text-sm font-medium text-text">{tokens(terms.walletCap, '', 0).trim()}</div>
              <div className="text-[10px] text-muted">tUSD cap</div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
