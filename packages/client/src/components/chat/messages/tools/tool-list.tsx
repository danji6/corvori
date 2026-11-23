import { cn } from '@/lib/utils'
import type { ReactNode } from 'react'

type ToolListProps = {
  children: ReactNode
  className?: string
}

/** Draws the shared tree layout for grouped tool calls. */
export function ToolList({ children, className }: ToolListProps) {
  return <ul className={cn('chat-tool-list', className)}>{children}</ul>
}

export function ToolListItem({ children, className }: ToolListProps) {
  return (
    <li
      className={cn('chat-tool-list-item relative min-w-0 text-xs', className)}
    >
      {children}
    </li>
  )
}
