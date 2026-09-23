import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'
import type { ButtonHTMLAttributes } from 'react'

const button = cva(
  'inline-flex items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40',
  {
    variants: {
      variant: {
        primary: 'bg-accent text-white hover:bg-accent/85',
        outline: 'border border-border bg-transparent text-text hover:bg-border/40',
        danger: 'bg-danger text-white hover:bg-danger/85',
        ghost: 'text-muted hover:text-text',
      },
      size: { sm: 'px-2.5 py-1 text-xs', md: '' },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
)

export function Button({ className, variant, size, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof button>) {
  return <button className={cn(button({ variant, size }), className)} {...p} />
}
