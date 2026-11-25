import {
  attachmentReplyCount,
  attachmentReplyLabel,
  clipReplyQuote,
  quotableText,
} from '@cv/core/reply-quote'
import type { UIMessage } from 'ai'
import { isTextUIPart } from 'ai'

import { isOptimisticMessageId } from './message-uploads'
import { segmentGroupsFor } from './rows'
import type { MessageRecord, ReplyTarget } from './types'
import type { GroupAddress } from './work-layout'

/** The message each session's composer is replying to. */
const targets = new Map<string, ReplyTarget>()
const listeners = new Set<() => void>()

function emit() {
  listeners.forEach((listener) => listener())
}

export function subscribeToReplyTargets(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getReplyTarget(sessionId: string | undefined) {
  return sessionId ? targets.get(sessionId) : undefined
}

export function setReplyTarget(sessionId: string, target: ReplyTarget) {
  targets.set(sessionId, target)
  emit()
}

export function clearReplyTarget(sessionId: string) {
  if (targets.delete(sessionId)) emit()
}

/** Removes and returns the session's reply target, for a message being sent. */
export function takeReplyTarget(sessionId: string) {
  const target = targets.get(sessionId)
  clearReplyTarget(sessionId)
  return target
}

/** Whether a transcript message is a settled part of the conversation. */
export function canReplyTo(
  message: UIMessage,
  record: MessageRecord | undefined,
): record is MessageRecord {
  if (!record || record.type || record.hidden) return false
  if (isOptimisticMessageId(message.id)) return false
  return (message as { status?: string }).status !== 'processing'
}

/** Quotes the selected text block or the whole message when it only has files. */
export function replyTargetFor(
  message: UIMessage,
  record: MessageRecord,
  scope?: GroupAddress | null,
): ReplyTarget | undefined {
  const selected = scopedReplyPart(message, record, scope)
  const text = selected
    ? quotableText([selected.part], false)
    : attachmentReplyLabel(fileReplyCount(message, record))
  if (!text) return undefined

  return {
    target: {
      id: message.id as ReplyTarget['target']['id'],
      creationTime: record._creationTime,
      ...(selected && { part: selected.address }),
    },
    sender: record.sender,
    senderName: record.senderName,
    text: clipReplyQuote(text),
  }
}

function fileReplyCount(message: UIMessage, record: MessageRecord): number {
  if (record.hasOlderSegments || record.hasNewerSegments) {
    return record.attachmentReplyCount ?? 0
  }
  return attachmentReplyCount([message.parts])
}

/** Resolves a scoped text block to its persistent segment and part indices. */
function scopedReplyPart(
  message: UIMessage,
  record: MessageRecord,
  scope: GroupAddress | null | undefined,
) {
  if (!scope) return undefined
  const slice = segmentGroupsFor(message, record).find(
    (slice) => slice.segmentIndex === scope.segmentIndex,
  )
  const group = slice?.groups[scope.groupIndex]
  if (group?.type !== 'single' || !isTextUIPart(group.part)) return undefined

  return {
    part: group.part,
    address: { segmentIndex: scope.segmentIndex, partIndex: group.index },
  }
}
