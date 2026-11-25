import { isNoteBoundaryRow } from './note-rows'
import type { MessageRow } from './rows'
import { isTranscriptDividerRow } from './sender-groups'

export type MessageBackgroundRange = {
  first: number
  last: number
  paletteMessageId: string
  messages: MessageBackgroundSpan[]
}

type MessageBackgroundSpan = {
  first: number
  last: number
  messageId: string
}

/** Finds contiguous surfaces in the projected transcript, including open details. */
export function messageBackgroundRanges(
  rows: readonly MessageRow[],
): MessageBackgroundRange[] {
  const ranges: MessageBackgroundRange[] = []
  let range: MessageBackgroundRange | undefined

  for (const [index, row] of rows.entries()) {
    const group = messageBackgroundGroup(row)
    if (!group) {
      range = undefined
      continue
    }

    if (range?.paletteMessageId !== group) {
      range = {
        first: index,
        last: index,
        paletteMessageId: group,
        messages: [],
      }
      ranges.push(range)
    } else {
      range.last = index
    }
    const lastMessage = range.messages.at(-1)
    if (lastMessage?.messageId === row.messageId) {
      lastMessage.last = index
    } else {
      range.messages.push({
        first: index,
        last: index,
        messageId: row.messageId,
      })
    }
  }
  return ranges
}

/** Returns the sender group only for rows that can carry a surface. */
export function messageBackgroundGroup(row?: MessageRow) {
  if (!row || row.summary) return
  if (isTranscriptDividerRow(row) || isNoteBoundaryRow(row)) return
  return row.senderGroupId ?? row.messageId
}
