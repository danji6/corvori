import { useMessageAppearance } from '@/hooks/chat/appearances'
import { useMessageStore } from '@/hooks/chat/messages'
import {
  type MessageBackgroundRange,
  messageBackgroundRanges,
} from '@/lib/chat/message-backgrounds'
import type { MessageRow } from '@/lib/chat/rows'
import { useScopedAppearance } from '@/lib/chat/scoped-appearance'
import { Fragment, memo, useMemo, useSyncExternalStore } from 'react'

import { useMessageHighlightRef } from '../message-highlight-context'
import { getRowSpacing } from './row-spacing'

type MessageBackgroundLayerProps = {
  rows: readonly MessageRow[]
  visibleIndices: readonly number[]
  getOffset: (index: number) => number
  getSize: (index: number) => number
}

export function MessageBackgroundLayer({
  rows,
  visibleIndices,
  getOffset,
  getSize,
}: MessageBackgroundLayerProps) {
  const ranges = useMemo(() => messageBackgroundRanges(rows), [rows])
  const firstVisible = visibleIndices[0]
  const lastVisible = visibleIndices.at(-1)
  if (firstVisible === undefined || lastVisible === undefined) return null
  const isVisible = ({ first, last }: { first: number; last: number }) =>
    last >= firstVisible && first <= lastVisible

  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 z-0">
      {ranges.filter(isVisible).map(renderRange)}
    </div>
  )

  function renderRange({
    first,
    last,
    paletteMessageId,
    messages,
  }: MessageBackgroundRange) {
    if (getOffset(last) + getSize(last) <= getOffset(first)) return null

    const singleMessage = messages.length === 1
    return (
      <Fragment key={rows[first]!.key}>
        <BackgroundSurface
          paletteMessageId={paletteMessageId}
          messageId={singleMessage ? messages[0]!.messageId : undefined}
          style={spanStyle(first, last, false, false)}
        >
          <SenderTint messageId={paletteMessageId} />
        </BackgroundSurface>
        {!singleMessage &&
          messages.filter(isVisible).map((span) => {
            const flatStart = span.first !== first
            const flatEnd = span.last !== last
            return (
              <BackgroundSurface
                key={span.messageId}
                messageId={span.messageId}
                flatStart={flatStart}
                flatEnd={flatEnd}
                style={spanStyle(span.first, span.last, flatStart, flatEnd)}
              />
            )
          })}
      </Fragment>
    )
  }

  function spanStyle(
    first: number,
    last: number,
    flatStart: boolean,
    flatEnd: boolean,
  ) {
    // Divide the shared background at the same midpoint as the gap menu.
    const top = rowEdge(first, flatStart ? 2 : 1)
    const end = flatEnd
      ? rowEdge(last + 1, 2)
      : `${getOffset(last) + getSize(last)}px`
    return { top, bottom: `calc(100% - ${end})` }
  }

  function rowEdge(index: number, divisor: number) {
    const offset = `${getOffset(index)}px`
    const gap = getRowSpacing(rows[index], rows[index - 1])
    return gap ? `calc(${offset} + ${gap} / ${divisor})` : offset
  }
}

type BackgroundSurfaceProps = {
  paletteMessageId?: string
  messageId?: string
  style: React.CSSProperties
  flatStart?: boolean
  flatEnd?: boolean
  children?: React.ReactNode
}

function BackgroundSurface({
  paletteMessageId,
  messageId,
  style,
  flatStart,
  flatEnd,
  children,
}: BackgroundSurfaceProps) {
  // A single-message surface can use the same element for tint and selection.
  const highlightRef = useMessageHighlightRef({
    messageId: messageId ?? '',
    segmentIndex: null,
    groupIndex: null,
    surface: 'background',
  })

  return (
    <div
      ref={messageId ? highlightRef : undefined}
      data-slot={
        paletteMessageId ? 'message-background' : 'message-background-part'
      }
      data-palette-message-id={paletteMessageId}
      data-flat-start={flatStart || undefined}
      data-flat-end={flatEnd || undefined}
      className="chat-message-background absolute"
      style={style}
    >
      {children}
    </div>
  )
}

const SenderTint = memo(function SenderTint({
  messageId,
}: {
  messageId: string
}) {
  const store = useMessageStore()
  const role = useSyncExternalStore(
    store.subscribe,
    () => store.getMessage(messageId)?.role,
  )
  const record = useSyncExternalStore(store.subscribe, () =>
    store.getMessageMetadata(messageId),
  )
  const { look } = useMessageAppearance(role ?? 'system', record)
  const palette = useScopedAppearance({ vars: look.vars, isDark: look.isDark })

  return <div data-slot="message-background-tint" className={palette} />
})
