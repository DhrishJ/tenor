'use client'
import * as SliderPrimitive from '@radix-ui/react-slider'
import { cn } from '@/lib/utils'

export function Slider({ className, ...props }: SliderPrimitive.SliderProps) {
  return (
    <SliderPrimitive.Root className={cn('relative flex h-6 w-full touch-none select-none items-center', className)} {...props}>
      <SliderPrimitive.Track className="relative h-2 grow overflow-hidden rounded-full bg-subtle">
        <SliderPrimitive.Range className="absolute h-full rounded-full bg-accent" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb aria-label="collateral amount" className="block h-5 w-5 rounded-full border-2 border-accent bg-white shadow-md focus:outline-none focus:ring-4 focus:ring-accent/20" />
    </SliderPrimitive.Root>
  )
}
