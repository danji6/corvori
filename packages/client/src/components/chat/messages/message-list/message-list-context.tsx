import { createOptionalContext } from '@/hooks/context'
import type { MessageRow } from '@/lib/chat/rows'
import type { ScrollCoordinator } from '@/lib/scroll-coordinator'
import type { ScrollLayoutAnchor } from '@/lib/scroll-layout'
import { createContext, useLayoutEffect } from 'react'

export const VirtualizedRowsContext = createContext<{
  rows: readonly MessageRow[]
  showBackgrounds: boolean
}>({ rows: [], showBackgrounds: false })

type MessageListContextValue = {
  scrollRef: React.RefObject<HTMLElement | null>
  scrollCoordinator?: ScrollCoordinator
  onLayoutChange: (anchor?: ScrollLayoutAnchor) => void
  onRowsMeasured?: () => void
  releaseFollow: () => void
  resumeFollow: () => void
  trackPendingLayout?: () => () => void
  shellFocusBlocked?: boolean
  restoreComposerFocus?: (input: HTMLElement) => void
  bottomPadding: number
  topPadding: number
}

export const [MessageListContext, useMessageList] =
  createOptionalContext<MessageListContextValue>()

/** Keeps edge navigation active until a mounted row's initial data arrives. */
export function usePendingMessageLayout(pending: boolean) {
  const track = useMessageList()?.trackPendingLayout
  useLayoutEffect(() => {
    if (pending) return track?.()
  }, [pending, track])
}
