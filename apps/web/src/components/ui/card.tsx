import { cn } from '@/lib/utils'
import type { HTMLAttributes, ReactNode } from 'react'

export function Card({ className, ...p }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-2xl border border-border bg-card p-6 shadow-card', className)} {...p} />
}
export function CardTitle({ className, ...p }: HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn('font-grotesk text-lg font-semibold tracking-tight text-text', className)} {...p} />
}
export function Label({ className, ...p }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('text-[11px] font-medium uppercase tracking-[0.08em] text-muted', className)} {...p} />
}

/** A labelled number, Aave-style: label, big value, optional sub-line. */
export function Stat({ label, value, sub, className, valueClassName }: { label: ReactNode; value: ReactNode; sub?: ReactNode; className?: string; valueClassName?: string }) {
  return (
    <div className={cn('min-w-0', className)}>
      <Label>{label}</Label>
      <div className={cn('num mt-1 truncate text-2xl font-semibold tracking-tight text-text', valueClassName)}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted">{sub}</div>}
    </div>
  )
}

/** Page title block: eyebrow pill, headline, lede. */
export function PageHeader({ eyebrow, title, children, right }: { eyebrow?: ReactNode; title: ReactNode; children?: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-6">
      <div className="max-w-3xl">
        {eyebrow && (
          <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-muted shadow-sm">
            <span className="h-1.5 w-1.5 rounded-full bg-success" />
            {eyebrow}
          </div>
        )}
        <h1 className="font-grotesk text-4xl font-bold tracking-tight text-text">{title}</h1>
        {children && <p className="mt-3 text-base leading-relaxed text-muted">{children}</p>}
      </div>
      {right}
    </div>
  )
}
