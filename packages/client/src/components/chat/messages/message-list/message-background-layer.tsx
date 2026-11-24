import { useMessageAppearance } from '@/hooks/chat/appearances'
import { useMessageStore } from '@/hooks/chat/messages'
import { messageBackgroundRanges } from '@/lib/chat/message-backgrounds'
import type { MessageRow } from '@/lib/chat/rows'
import { useScopedAppearance } from '@/lib/chat/scoped-appearance'
import { memo, useMemo, useSyncExternalStore } from 'react'

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

  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 z-0">
      {ranges
        .filter(
          ({ first, last }) => last >= firstVisible && first <= lastVisible,
        )
        .map(({ first, last, paletteMessageId }) => {
          const start = getOffset(first)
          const end = getOffset(last) + getSize(last)
          if (end <= start) return null

          const row = rows[first]!
          const gap = getRowSpacing(row, rows[first - 1])
          return (
            <div
              key={row.key}
              data-slot="message-background"
              data-palette-message-id={paletteMessageId}
              className="chat-message-background absolute rounded-2xl"
              style={{
                top: gap ? `calc(${start}px + ${gap})` : start,
                bottom: `calc(100% - ${end}px)`,
              }}
            >
              <SenderTint messageId={paletteMessageId} />
            </div>
          )
        })}
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
