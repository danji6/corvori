import { Accordion, Button } from '@/components/ui'
import { useNoteExpansion } from '@/hooks/chat/note-expansion'
import type { MessageRow } from '@/lib/chat/rows'
import { NotepadTextIcon } from 'lucide-react'

import { useMessageList } from './message-list/message-list-context'
import { getMountedTransitionRows } from './virtualized-row-transition'

export function NoteGroupBlock({
  row,
}: {
  row: Extract<MessageRow, { kind: 'note-group' }>
}) {
  const [open, onOpenChange] = useNoteExpansion(row.key)
  const list = useMessageList()

  return (
    <Button
      data-slot="note-group-block"
      data-open={open}
      variant="plain"
      size={null}
      aria-expanded={open}
      aria-label={`${open ? 'Collapse' : 'Expand'} ${row.count} notes`}
      onClick={() => {
        list?.onLayoutChange()
        const mountedRows = getMountedTransitionRows(
          'data-note-group-id',
          row.key,
        )
        onOpenChange(!open, mountedRows)
      }}
      className="chat-header-focus chat-summary-row text-muted-foreground flex max-w-full items-center justify-start gap-2 text-left text-xs whitespace-normal focus-visible:ring-0"
    >
      <NotepadTextIcon className="size-3.5" />
      <span className="min-w-0 wrap-anywhere">{row.count} notes</span>
      <Accordion.Icon
        aria-hidden
        isExpanded={open}
        className="chat-collapsible-chevron shrink-0"
      />
    </Button>
  )
}
