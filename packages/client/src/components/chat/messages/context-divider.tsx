import { cn } from '@/lib/utils'
import type { ReactNode } from 'react'

export function ContextDivider({
  label,
  className,
}: {
  label: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'text-muted-foreground/50 flex w-full items-center gap-3 text-xs',
        className,
      )}
    >
      <div className="h-px flex-1 bg-current opacity-30" />
      <span className="flex min-w-0 items-center gap-1.5">{label}</span>
      <div className="h-px flex-1 bg-current opacity-30" />
    </div>
  )
}
