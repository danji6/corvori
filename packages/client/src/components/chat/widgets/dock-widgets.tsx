import { cn } from '@/lib/utils'

import { SubagentsWidget } from './subagents-widget'
import { TerminalsWidget } from './terminals-widget'
import { TodosWidget } from './todos-widget'

const WIDGET = 'bg-background/80 pointer-events-auto h-9 px-3 backdrop-blur-md'

export function DockWidgets({
  ref,
  className,
  review,
  toolbar,
}: {
  ref?: React.Ref<HTMLDivElement>
  className?: string
  review?: React.ReactNode
  toolbar?: React.ReactNode
}) {
  // Reserve a row even when there are no widgets.
  return (
    <div
      ref={ref}
      data-slot="dock-widgets"
      className={cn(
        'pointer-events-none mb-(--dock-widgets-gap) flex items-center gap-2 px-1',
        review
          ? 'min-h-(--dock-widgets-height) flex-wrap'
          : 'h-(--dock-widgets-height)',
        className,
      )}
    >
      {review}
      <TerminalsWidget className={WIDGET} />
      <TodosWidget className={WIDGET} />
      <SubagentsWidget className={WIDGET} />
      {toolbar}
    </div>
  )
}
