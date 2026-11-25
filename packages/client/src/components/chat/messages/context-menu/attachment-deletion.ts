import type { MessageRecord } from '@/lib/chat'
import type { SegmentGroups } from '@/lib/chat/rows'
import type { Id } from '@cv/convex/_generated/dataModel'
import type { DeleteMessageAttachmentArgs } from '@cv/convex/validators/messages'
import {
  isAttachmentCompanionContent,
  messageFileKey,
} from '@cv/core/attachments'
import type { UIMessage } from 'ai'

import type { GroupScope } from './message-menu-state'

export type AttachmentDeletion = {
  args: DeleteMessageAttachmentArgs
  filename: string
  isLastContent: boolean
}

type AttachmentSelection = {
  tile: HTMLElement | undefined
  scope: GroupScope | null
  slices: SegmentGroups[]
  message: UIMessage
  record: MessageRecord | undefined
}

/** Resolves a file tile to its occurrence in the selected message version. */
export function selectAttachmentDeletion({
  tile,
  scope,
  slices,
  message,
  record,
}: AttachmentSelection): AttachmentDeletion | null {
  const index = Number(tile?.dataset.attachmentIndex)
  if (!Number.isSafeInteger(index) || index < 0 || !scope || !record)
    return null

  const slice = slices.find((slice) => slice.segmentIndex === scope.segmentIndex) // prettier-ignore
  const group = slice?.groups[scope.groupIndex]
  if (!slice || group?.type !== 'files') return null

  const file = group.parts[index]
  const expectedFileKey = messageFileKey(file)
  if (expectedFileKey === undefined) return null

  const address = {
    segmentIndex: scope.segmentIndex,
    partIndex: group.startIndex + index,
  }
  const hasOtherContent = slices.some((segment) =>
    segment.parts.some((part, index) => {
      const selected =
        segment.segmentIndex === address.segmentIndex &&
        index === address.partIndex
      return !selected && isAttachmentCompanionContent(part)
    }),
  )

  return {
    args: {
      messageId: message.id as Id<'messages'>,
      address,
      expectedVersion: record.selectedVersion,
      expectedSegmentPartCount: slice.parts.length,
      expectedFileKey,
    },
    filename: tile?.dataset.attachmentName || file.filename || 'Attachment',
    isLastContent:
      !record.hasOlderSegments && !record.hasNewerSegments && !hasOtherContent,
  }
}
