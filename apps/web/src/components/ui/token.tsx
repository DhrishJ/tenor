import { cn } from '@/lib/utils'

/** Token marks for the two mock tokens (no third-party logos). */
export function TokenIcon({ symbol, className }: { symbol: 'tUSD' | 'tCOLL'; className?: string }) {
  const coll = symbol === 'tCOLL'
  return (
    <span
      className={cn(
        'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full font-grotesk text-xs font-bold text-white shadow-sm',
        coll ? 'bg-gradient-to-br from-indigo-500 to-violet-600' : 'bg-gradient-to-br from-emerald-500 to-teal-600',
        className,
      )}
      aria-hidden
    >
      {coll ? 'C' : '$'}
    </span>
  )
}
