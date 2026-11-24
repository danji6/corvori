import { useCallback, useEffect, useRef, useState } from 'react'

const SCROLL_KEYS = new Set([
  ' ',
  'ArrowDown',
  'ArrowUp',
  'End',
  'Home',
  'PageDown',
  'PageUp',
])

/** Keeps the dock visible after restoring composer focus. */
export function useComposerReveal(
  sessionId: string | undefined,
  isAtBottom: boolean,
) {
  const [heldSessionId, setHeldSessionId] = useState<string>()
  const visible = heldSessionId !== undefined && heldSessionId === sessionId
  if (heldSessionId !== undefined && !visible) setHeldSessionId(undefined)

  const clear = useCallback(() => setHeldSessionId(undefined), [])

  const keepVisible = useCallback(() => {
    if (sessionId) setHeldSessionId(sessionId)
  }, [sessionId])

  const wasAtBottom = useRef(isAtBottom)
  useEffect(() => {
    if (isAtBottom && !wasAtBottom.current) clear()
    wasAtBottom.current = isAtBottom
  }, [isAtBottom, clear])

  useEffect(() => {
    if (!visible) return
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY && isTranscriptGesture(event)) clear()
    }
    const onTouchMove = (event: TouchEvent) => {
      if (isTranscriptGesture(event)) clear()
    }
    const onKey = (event: KeyboardEvent) => {
      if (isTranscriptScrollKey(event)) clear()
    }
    window.addEventListener('wheel', onWheel, { passive: true })
    window.addEventListener('touchmove', onTouchMove, { passive: true })
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('wheel', onWheel)
      window.removeEventListener('touchmove', onTouchMove)
      window.removeEventListener('keydown', onKey)
    }
  }, [visible, clear])

  return { visible, clear, keepVisible }
}

function isTranscriptGesture(event: Event) {
  if (event.defaultPrevented) return false
  return !(
    event.target instanceof Element &&
    event.target.closest(
      '[data-slot="chat-dock"], [data-slot="terminal-wrapper"], [role="dialog"]',
    )
  )
}

function isTranscriptScrollKey(event: KeyboardEvent) {
  if (!SCROLL_KEYS.has(event.key) || !isTranscriptGesture(event)) return false
  const target = event.target
  if (!(target instanceof HTMLElement)) return true
  if (target.isContentEditable || target.closest('input, textarea, select'))
    return false
  return event.key !== ' ' || !target.closest('button, [role="button"]')
}
