import {
  MESSAGE_MENU_TRIGGER,
  forwardMessageMenuMouse,
} from '../context-menu/forward-message-menu'
import {
  type HighlightElements,
  MESSAGE_HIGHLIGHT_PADDING,
  useMessageHighlightElements,
} from '../message-highlight-context'

const MENU_EDGE_TOLERANCE = 4
const MENU_HIT_PADDING = MESSAGE_HIGHLIGHT_PADDING + MENU_EDGE_TOLERANCE

type MenuMouseEvent = React.MouseEvent<HTMLDivElement>
type MenuPoint = Pick<MouseEvent, 'clientX' | 'clientY'>

/** Exposes blank transcript space to proximity hit testing. */
export function MessageMenuSpace({
  className,
  style,
}: Pick<React.ComponentProps<'div'>, 'className' | 'style'>) {
  return (
    <div
      aria-hidden
      data-message-menu-space
      data-context-menu-trigger
      className={className}
      style={style}
    />
  )
}

export function MessageMenuHitArea() {
  return (
    <MessageMenuSpace
      className="absolute"
      style={{
        insetBlock: -MENU_HIT_PADDING,
        insetInline: `calc(-1 * max(var(--message-surface-outset) + ${MENU_EDGE_TOLERANCE}px, ${MENU_HIT_PADDING}px))`,
      }}
    />
  )
}

export function useNearbyMessageMenu() {
  const highlightElements = useMessageHighlightElements()

  return (event: MenuMouseEvent) => {
    if (!(event.target instanceof Element)) return
    if (!event.target.hasAttribute('data-message-menu-space')) return
    if (!highlightElements) return

    forwardMessageMenuMouse(event, () =>
      findNearbyMessageMenu(
        highlightElements.current,
        event.currentTarget,
        event,
      ),
    )
  }
}

function findNearbyMessageMenu(
  elements: HighlightElements,
  transcript: HTMLElement,
  point: MenuPoint,
) {
  const messageId = findBackgroundMessage(elements, transcript, point)
  let closest: Element | null = null
  let closestDistance = Infinity

  for (const [element, target] of elements) {
    if (target.surface === 'background') continue
    if (messageId && target.messageId !== messageId) continue

    const trigger = element.closest(MESSAGE_MENU_TRIGGER)
    if (!trigger || !transcript.contains(trigger)) continue

    const distance = distanceToSurface(
      element.getBoundingClientRect(),
      point,
      messageId ? Infinity : MENU_HIT_PADDING,
    )
    if (distance >= closestDistance) continue
    if (trigger.closest('[inert]')) continue
    if (getComputedStyle(element).visibility !== 'visible') continue

    closest = trigger
    closestDistance = distance
  }

  return closest
}

/** Uses the same surface bounds as the full-message highlight. */
function findBackgroundMessage(
  elements: HighlightElements,
  transcript: HTMLElement,
  point: MenuPoint,
) {
  let closest: string | undefined
  let closestDistance = Infinity

  for (const [element, target] of elements) {
    if (target.surface !== 'background' || !transcript.contains(element))
      continue
    const distance = distanceToSurface(
      element.getBoundingClientRect(),
      point,
      MENU_EDGE_TOLERANCE,
    )
    if (distance === 0) return target.messageId
    if (distance >= closestDistance) continue
    closest = target.messageId
    closestDistance = distance
  }

  return closest
}

function distanceToSurface(
  rect: DOMRect,
  { clientX, clientY }: MenuPoint,
  padding: number,
) {
  if (!rect.width || !rect.height) return Infinity

  const x = Math.max(rect.left - clientX, clientX - rect.right, 0)
  const y = Math.max(rect.top - clientY, clientY - rect.bottom, 0)
  if (Math.max(x, y) > padding) return Infinity
  return x * x + y * y
}
