import { useActiveSession } from '@/hooks/chat/session'
import type { MessageRecord } from '@/lib/chat'
import {
  canReplyTo,
  replyTargetFor,
  setReplyTarget,
} from '@/lib/chat/reply-target-store'
import type { UIMessage } from 'ai'

/** Starts a reply to the message, or is undefined when it can't be quoted. */
export function useReplyAction(
  message: UIMessage,
  record: MessageRecord | undefined,
) {
  const session = useActiveSession()

  // Sub-agent sessions have no composer to reply from
  if (!session || session.parent) return undefined
  if (!canReplyTo(message, record)) return undefined

  return () => setReplyTarget(session._id, replyTargetFor(message, record))
}
