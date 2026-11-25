import { isNoteBoundaryRow } from '@/lib/chat/note-rows'
import type { MessageRow } from '@/lib/chat/rows'
import { isTranscriptDividerRow } from '@/lib/chat/sender-groups'

import {
  MESSAGE_MENU_TRIGGER,
  forwardMessageMenuMouse,
} from '../context-menu/forward-message-menu'
import { MessageMenuSpace } from './nearby-message-menu'

type MessageMenuGapProps = {
  height: string
  row?: MessageRow
  adjacent?: MessageRow
  trailing?: boolean
}

/** Keeps the layout spacer while routing its gestures to the adjoining menus. */
export function MessageMenuGap({
  height,
  row,
  adjacent,
  trailing = false,
}: MessageMenuGapProps) {
  const style = { height }
  if (!row || !adjacent || !shareMessageSpace(row, adjacent)) {
    return <MessageMenuSpace style={style} />
  }

  const own = <GapTrigger rowKey={row.key} />
  const other = (
    <GapTrigger rowKey={adjacent.key} side={trailing ? 'next' : 'previous'} />
  )
  const split = row.messageId !== adjacent.messageId

  return (
    <div aria-hidden className="grid auto-rows-fr" style={style}>
      {split && !trailing && other}
      {own}
      {split && trailing && other}
    </div>
  )
}

function shareMessageSpace(row: MessageRow, adjacent: MessageRow) {
  if (isNoteBoundaryRow(row) || isNoteBoundaryRow(adjacent)) return false
  if (isTranscriptDividerRow(row) || isTranscriptDividerRow(adjacent)) {
    return false
  }

  const group = row.senderGroupId ?? row.messageId
  const adjacentGroup = adjacent.senderGroupId ?? adjacent.messageId
  return row.messageId === adjacent.messageId || group === adjacentGroup
}

type GapTriggerProps = {
  rowKey: string
  side?: 'previous' | 'next'
}

function GapTrigger({ rowKey, side }: GapTriggerProps) {
  function findTrigger(target: HTMLElement) {
    const own = target.closest('[data-slot="virtualized-item"]')
    const row =
      side === 'previous'
        ? own?.previousElementSibling
        : side === 'next'
          ? own?.nextElementSibling
          : own
    // Virtualization can leave a nonadjacent row as the immediate DOM sibling.
    if (row?.getAttribute('data-row-key') !== rowKey) return null
    return row.querySelector(MESSAGE_MENU_TRIGGER)
  }

  function forwardMouse(event: React.MouseEvent<HTMLDivElement>) {
    forwardMessageMenuMouse(event, () => findTrigger(event.currentTarget))
  }

  function forwardTouch(event: React.TouchEvent<HTMLDivElement>) {
    const trigger = findTrigger(event.currentTarget)
    if (!trigger) return

    const { bubbles, cancelable, composed, touches } = event.nativeEvent
    const forwarded = new TouchEvent(event.type, {
      bubbles,
      cancelable,
      composed,
      touches: Array.from(touches),
    })
    if (!trigger.dispatchEvent(forwarded)) event.preventDefault()
  }

  return (
    <div
      data-context-menu-trigger
      onContextMenu={forwardMouse}
      onMouseDown={forwardMouse}
      onTouchStart={forwardTouch}
      onTouchMove={forwardTouch}
      onTouchEnd={forwardTouch}
      onTouchCancel={forwardTouch}
    />
  )
}
