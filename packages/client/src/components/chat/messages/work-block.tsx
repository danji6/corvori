import { Accordion, Button } from '@/components/ui'
import { useIsMessageStreaming } from '@/hooks/chat/stream'
import type { MessageRecord } from '@/lib/chat'
import { type MessageRow, segmentGroupsFor } from '@/lib/chat/rows'
import { workExpansion } from '@/lib/chat/work-state'
import { summarizeWork } from '@/lib/chat/work-summary'
import { cn } from '@/lib/utils'
import type { UIMessage } from 'ai'
import { useMemo, useSyncExternalStore } from 'react'

import { useMessageHighlightRef } from './message-highlight-context'
import { useMessageList } from './message-list/message-list-context'
import { getMountedTransitionRows } from './virtualized-row-transition'

type WorkBlockProps = {
  row: Extract<MessageRow, { kind: 'work' }>
  message: UIMessage
  record?: MessageRecord
  toolErrors?: string[]
}

/** Toggles virtualized work rows without mounting a second scrolling container. */
export function WorkBlock({
  row,
  message,
  record,
  toolErrors,
}: WorkBlockProps) {
  const workId = row.work.id
  const open = useSyncExternalStore(workExpansion.subscribe, () =>
    workExpansion.getSnapshot().has(workId),
  )
  const list = useMessageList()
  const isStreaming = useIsMessageStreaming(message.id)
  const highlightRef = useMessageHighlightRef(message.id)

  const summary = useMemo(
    () =>
      summarizeWork(row.work, segmentGroupsFor(message, record), toolErrors),
    [row.work, message, record, toolErrors],
  )

  const toggle = () => {
    list?.onLayoutChange()
    const mountedRows = getMountedTransitionRows('data-work-id', workId)
    workExpansion.setOpen(workId, !open, mountedRows)
  }

  return (
    <Button
      ref={highlightRef}
      data-slot="work-block"
      data-open={open}
      variant="plain"
      size={null}
      aria-expanded={open}
      aria-label={`${open ? 'Collapse' : 'Expand'} work: ${summary.label}`}
      onClick={toggle}
      className="chat-header-focus chat-summary-row text-muted-foreground flex max-w-full items-center justify-start gap-2 text-left text-xs whitespace-normal focus-visible:ring-0"
    >
      <span
        className={cn(
          'min-w-0 wrap-anywhere',
          isStreaming && summary.running && 'text-shimmer',
        )}
      >
        {summary.label}
        {row.work.partial && ' · loaded portion'}
      </span>
      <Accordion.Icon
        aria-hidden
        isExpanded={open}
        className="chat-collapsible-chevron shrink-0"
      />
    </Button>
  )
}
