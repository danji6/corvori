import { STREAM_PATCH_INTERVAL_MS } from '@cv/core/const'
import { useEffect, useRef, useState } from 'react'

const MS_PER_CHARACTER = 25
const REVEAL_WINDOW_MS = STREAM_PATCH_INTERVAL_MS - 16

function revealBoundary(text: string, index: number, previous: number) {
  if (index === text.length) return index
  // Avoid revealing a partial Markdown opener or UTF-16 surrogate pair.
  while (index > previous && /[*`]/.test(text[index - 1])) {
    index--
  }
  const code = text.charCodeAt(index - 1)
  return index > previous && code >= 0xd800 && code <= 0xdbff
    ? index - 1
    : index
}

/** Paces incoming text across the patch interval and finishes during silence. */
export function useSmoothedText(text: string, streaming: boolean) {
  const [visible, setVisible] = useState(text)
  const revealed = useRef(text)

  useEffect(() => {
    const previous = revealed.current
    if (previous === text) return

    const from =
      streaming && text.startsWith(previous) ? previous.length : text.length
    const count = text.length - from
    const duration = Math.min(REVEAL_WINDOW_MS, count * MS_PER_CHARACTER)
    const started = performance.now()
    let index = from
    let frame: number

    const tick = (now: number) => {
      const progress = duration ? Math.min(1, (now - started) / duration) : 1
      const target =
        from + Math.min(count, Math.max(1, Math.floor(count * progress)))
      index = revealBoundary(text, target, index)
      const next = text.slice(0, index)
      if (next !== revealed.current) {
        revealed.current = next
        setVisible(next)
      }
      if (index < text.length) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [streaming, text])

  return streaming && text.startsWith(visible) ? visible : text
}
