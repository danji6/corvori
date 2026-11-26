import { trackUntilSettled } from './scroll-settle'
import type { ScrollTarget } from './scroll-target'

export type ScrollLayoutAnchor = 'top' | 'bottom'

type LayoutPositionOptions = {
  anchor: ScrollLayoutAnchor
  pending?: () => boolean
  done: () => void
}

/** Retains the chosen viewport edge while animated rows and measurements settle. */
export function preserveLayoutPosition(
  target: ScrollTarget,
  { anchor, pending, done }: LayoutPositionOptions,
) {
  const top = target.getScrollTop()
  let height = target.getScrollHeight()

  const restore = (scrollHeight = target.getScrollHeight()) => {
    const bottom = Math.max(0, scrollHeight - target.getClientHeight())
    const position = anchor === 'bottom' ? bottom : Math.min(top, bottom)
    if (Math.abs(target.getScrollTop() - position) > 0.5) {
      target.setScrollTop(position)
    }
  }

  const cancel = trackUntilSettled(
    () => {
      const next = target.getScrollHeight()
      restore(next)
      const delta = next - height
      height = next
      return delta
    },
    { pending, onDone: done, tolerance: anchor === 'bottom' ? 0 : undefined },
  )

  return { anchor, restore, cancel }
}
