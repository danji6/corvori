import { useMessageList } from '@/components/chat/messages/message-list/message-list-context'
import { useEffect, useRef } from 'react'

const EXTRA_PADDING = 48

type ScrollIntoViewParams = {
  active: boolean
  blockRef: React.RefObject<HTMLElement | null>
}

/** Brings the start of a presented plan below the nav once layout settles. */
export function useScrollIntoView({ active, blockRef }: ScrollIntoViewParams) {
  const messageList = useMessageList()
  const coordinator = messageList?.scrollCoordinator
  const scrollRef = messageList?.scrollRef
  const prevActive = useRef(false)
  const listRef = useRef(messageList)

  useEffect(() => {
    listRef.current = messageList
  })

  useEffect(() => {
    const wasActive = prevActive.current
    prevActive.current = active

    if (!active || wasActive) return

    const scrollEl = scrollRef?.current
    const blockEl = blockRef.current
    if (!scrollEl || !blockEl) return

    listRef.current?.releaseFollow()

    // The layout hold owns the viewport until the expansion settles.
    const layoutIsCurrent =
      coordinator?.kind === 'layout' ? coordinator.checkpoint() : null
    const isDocScroll = scrollEl === document.documentElement

    const getScrollHeight = () =>
      isDocScroll
        ? document.documentElement.scrollHeight
        : scrollEl.scrollHeight

    let rafId = 0
    let frames = 0
    let stableFrames = 0
    let prevScrollHeight = -1
    let prevBlockHeight = -1
    let cancelled = false
    let finished = false

    const cancel = () => {
      cancelled = true
    }

    const scrollBy = (top: number) => {
      listRef.current?.releaseFollow()
      const opts: ScrollToOptions = { top, behavior: 'smooth' }
      if (isDocScroll) window.scrollBy(opts)
      else scrollEl.scrollBy(opts)
    }

    const reveal = () => {
      const { bottomPadding = 0, topPadding = 0 } = listRef.current ?? {}
      const spacingPx =
        parseFloat(getComputedStyle(scrollEl).getPropertyValue('--spacing')) *
          16 || 4
      const topPaddingPx = topPadding * spacingPx
      const scrollRect = isDocScroll
        ? new DOMRect(0, 0, window.innerWidth, window.innerHeight)
        : scrollEl.getBoundingClientRect()
      const { top, bottom } = blockEl.getBoundingClientRect()
      const visibleBottom = scrollRect.bottom - bottomPadding - EXTRA_PADDING
      const targetTop = scrollRect.top + topPaddingPx + 16
      const alreadyReadable =
        top >= targetTop - 1 &&
        (top <= targetTop + 1 || bottom <= visibleBottom)
      if (!alreadyReadable) scrollBy(top - targetTop)
    }

    const waitForSettle = () => {
      if (cancelled || layoutIsCurrent?.() === false) return cleanup()
      if (layoutIsCurrent && coordinator?.kind === 'layout') {
        rafId = requestAnimationFrame(waitForSettle)
        return
      }

      const scrollHeight = getScrollHeight()
      const blockHeight = blockEl.getBoundingClientRect().height
      const layoutUnchanged =
        scrollHeight === prevScrollHeight && blockHeight === prevBlockHeight
      stableFrames = layoutUnchanged ? stableFrames + 1 : 0
      prevScrollHeight = scrollHeight
      prevBlockHeight = blockHeight

      if (stableFrames >= 2 || ++frames >= 60) {
        reveal()
        cleanup()
      } else {
        rafId = requestAnimationFrame(waitForSettle)
      }
    }

    const cleanup = () => {
      if (finished) return
      finished = true
      cancelAnimationFrame(rafId)
      window.removeEventListener('wheel', cancel)
      window.removeEventListener('touchmove', cancel)
    }

    window.addEventListener('wheel', cancel, { passive: true })
    window.addEventListener('touchmove', cancel, { passive: true })
    rafId = requestAnimationFrame(waitForSettle)

    return cleanup
  }, [active, blockRef, scrollRef, coordinator])
}
