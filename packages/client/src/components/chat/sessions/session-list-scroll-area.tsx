import { OverlayScrollArea } from '@/components/ui/overlay-scroll-area'
import { useSessionDragScroll } from '@/hooks/chat/session-drag-scroll'
import type { ReactNode, RefObject } from 'react'

type SessionListScrollAreaProps = {
  children: ReactNode
  ref: RefObject<HTMLDivElement | null>
}

/** Scrolls folders and sessions without accepting background drops. */
export function SessionListScrollArea({
  children,
  ref,
}: SessionListScrollAreaProps) {
  useSessionDragScroll(ref)

  return (
    <OverlayScrollArea
      ref={ref}
      data-slot="session-list-scroll-area"
      className="flex-1 [overflow-anchor:none]"
      contentClassName="px-2"
    >
      {children}
    </OverlayScrollArea>
  )
}
