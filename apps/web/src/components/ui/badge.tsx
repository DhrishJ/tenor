import { cn } from '@/lib/utils'
import type { HTMLAttributes } from 'react'

const tones = {
  neutral: 'border-border bg-subtle text-muted',
  accent: 'border-accent/20 bg-accent/[0.06] text-accent',
  success: 'border-success/25 bg-success/[0.07] text-success',
  warning: 'border-amber-300/70 bg-amber-50 text-warning',
  danger: 'border-danger/25 bg-danger/[0.06] text-danger',
}
const dots = { neutral: 'bg-muted', accent: 'bg-accent', success: 'bg-success', warning: 'bg-amber-500', danger: 'bg-danger' }

export function Badge({ tone = 'neutral', dot = false, className, children, ...p }: HTMLAttributes<HTMLSpanElement> & { tone?: keyof typeof tones; dot?: boolean }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium', tones[tone], className)} {...p}>
      {dot && <span className={cn('h-1.5 w-1.5 rounded-full', dots[tone])} />}
      {children}
    </span>
  )
}
