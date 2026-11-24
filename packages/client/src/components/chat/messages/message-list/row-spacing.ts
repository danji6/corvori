import { isNoteBoundaryRow } from '@/lib/chat/note-rows'
import type { MessageRow } from '@/lib/chat/rows'
import { isTranscriptDividerRow } from '@/lib/chat/sender-groups'

function startsSenderGroup(row: MessageRow, previousRow: MessageRow) {
  return !row.grouped && previousRow.messageId !== row.messageId
}

function isCollapsibleWorkDetail(row: MessageRow) {
  return row.kind === 'group' && row.workId && !row.promotedToolCallIds
}

/** Keeps the gap before a stacked summary inside the collapsing details. */
export function getWorkDetailTrailingSpacing(
  row?: MessageRow,
  nextRow?: MessageRow,
) {
  if (!row || !isCollapsibleWorkDetail(row) || nextRow?.kind !== 'work') return
  if (!startsSenderGroup(nextRow, row)) return 'var(--message-block-gap)'
}

/** Chooses gaps whose values live in styles/messages.css. */
export function getRowSpacing(row?: MessageRow, previousRow?: MessageRow) {
  if (!row || row.kind === 'footer') return

  if (
    previousRow &&
    (isTranscriptDividerRow(row) || isTranscriptDividerRow(previousRow))
  ) {
    return 'var(--message-sender-gap)'
  }

  if (row.kind === 'hidden' && row.noteGroupId) {
    // The group header's padding already separates it from the first note.
    if (previousRow?.key === row.noteGroupId) return
    return 'var(--note-group-row-gap)'
  }

  if (previousRow && isNoteBoundaryRow(row)) {
    return 'var(--message-note-gap)'
  }

  const followsNote = isNoteBoundaryRow(previousRow)
  const isSummary = row.kind === 'group' && row.summary
  if (previousRow && startsSenderGroup(row, previousRow) && !followsNote) {
    return isSummary
      ? 'var(--message-compaction-gap)'
      : 'var(--message-sender-gap)'
  }

  if (isCollapsibleWorkDetail(row)) return 'var(--work-row-gap)'
  if (!previousRow) return
  if (followsNote) return 'var(--message-note-gap)'
  if (isSummary) return 'var(--message-compact-block-gap)'

  // Work summaries use header padding and any gap carried by the preceding details.
  const stacksWorkSummaries =
    row.kind === 'work' &&
    (previousRow.kind === 'work' ||
      previousRow.kind === 'footer' ||
      isCollapsibleWorkDetail(previousRow))
  if (stacksWorkSummaries) return

  if (previousRow.kind === 'header') return 'var(--message-header-gap)'

  return 'var(--message-block-gap)'
}
