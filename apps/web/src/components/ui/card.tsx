import { cn } from '@/lib/utils'
import type { HTMLAttributes } from 'react'

export function Card({ className, ...p }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-lg border border-border bg-card p-5', className)} {...p} />
}
export function CardTitle({ className, ...p }: HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn('font-grotesk text-lg font-semibold', className)} {...p} />
}
export function Label({ className, ...p }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('text-xs uppercase tracking-wide text-muted', className)} {...p} />
}
