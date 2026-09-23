import { cn } from '@/lib/utils'
import type { HTMLAttributes } from 'react'

const tones = {
  neutral: 'border-border text-muted',
  accent: 'border-accent/50 text-accent',
  success: 'border-success/50 text-success',
  warning: 'border-warning/60 text-warning',
  danger: 'border-danger/60 text-danger',
}
export function Badge({ tone = 'neutral', className, ...p }: HTMLAttributes<HTMLSpanElement> & { tone?: keyof typeof tones }) {
  return <span className={cn('inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] font-medium', tones[tone], className)} {...p} />
}
