import { cn } from '@/lib/utils'
import { type ComponentProps, type RefObject, useRef } from 'react'

import { OverlayScrollbar } from './overlay-scrollbar'

type OverlayScrollAreaProps = ComponentProps<'div'> & {
  ref?: RefObject<HTMLDivElement | null>
  contentClassName?: string
}

/** Keeps native scrolling and draws the scrollbar over the viewport. */
export function OverlayScrollArea({
  ref,
  className,
  contentClassName,
  children,
  ...props
}: OverlayScrollAreaProps) {
  const localRef = useRef<HTMLDivElement>(null)
  const viewportRef = ref ?? localRef
  const contentRef = useRef<HTMLDivElement>(null)

  return (
    <div
      ref={viewportRef}
      className={cn(
        'no-scrollbar min-h-0 overflow-x-hidden overflow-y-auto',
        className,
      )}
      {...props}
    >
      <OverlayScrollbar element={{ viewportRef, contentRef }} />
      <div ref={contentRef} className={cn('flow-root', contentClassName)}>
        {children}
      </div>
    </div>
  )
}
