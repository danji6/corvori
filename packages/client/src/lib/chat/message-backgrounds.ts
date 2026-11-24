import { isNoteBoundaryRow } from './note-rows'
import type { MessageRow } from './rows'
import { isTranscriptDividerRow } from './sender-groups'

export type MessageBackgroundRange = {
  first: number
  last: number
  paletteMessageId: string
}

/** Finds contiguous surfaces in the projected transcript, including open details. */
export function messageBackgroundRanges(
  rows: readonly MessageRow[],
): MessageBackgroundRange[] {
  const ranges: MessageBackgroundRange[] = []
  let previousGroup: string | undefined

  for (const [index, row] of rows.entries()) {
    const group = messageBackgroundGroup(row)
    if (!group) {
      previousGroup = undefined
      continue
    }

    if (previousGroup === group) {
      ranges[ranges.length - 1]!.last = index
    } else {
      ranges.push({ first: index, last: index, paletteMessageId: group })
    }
    previousGroup = group
  }
  return ranges
}

/** Returns the sender group only for rows that can carry a surface. */
export function messageBackgroundGroup(row?: MessageRow) {
  if (!row || row.summary) return
  if (isTranscriptDividerRow(row) || isNoteBoundaryRow(row)) return
  return row.senderGroupId ?? row.messageId
}
