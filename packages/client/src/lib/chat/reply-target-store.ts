import { clipReplyQuote, quotableText } from '@cv/core/reply-quote'
import type { UIMessage } from 'ai'

import { isOptimisticMessageId } from './message-uploads'
import type { MessageRecord, ReplyTarget } from './types'

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

/** Quotes a transcript message for the composer to reply to. */
export function replyTargetFor(
  message: UIMessage,
  record: MessageRecord,
): ReplyTarget {
  const answerLast = message.role === 'assistant'
  return {
    target: {
      id: message.id as ReplyTarget['target']['id'],
      creationTime: record._creationTime,
    },
    sender: record.sender,
    ...(record.senderName && { senderName: record.senderName }),
    text: clipReplyQuote(quotableText(message.parts, answerLast)),
  }
}
