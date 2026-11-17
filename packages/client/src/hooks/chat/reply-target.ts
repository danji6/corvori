import type { ComposerHandle } from '@/hooks/chat/composer-editor'
import type { PendingMessage } from '@/lib/chat'
import {
  clearReplyTarget,
  getReplyTarget,
  setReplyTarget,
  subscribeToReplyTargets,
  takeReplyTarget,
} from '@/lib/chat/reply-target-store'
import { useCallback, useEffect, useSyncExternalStore } from 'react'

/** The message the session's composer is replying to, if any. */
export function useReplyTarget(sessionId: string | undefined) {
  return useSyncExternalStore(
    subscribeToReplyTargets,
    () => getReplyTarget(sessionId),
    () => undefined,
  )
}

type ComposerReplyOptions<Result> = {
  sessionId: string | undefined
  composerRef: React.RefObject<ComposerHandle | null>
  onSubmit: (message: PendingMessage) => Promise<Result>
}

/** Attaches the session's reply target to the next message the composer sends. */
export function useComposerReply<Result>({
  sessionId,
  composerRef,
  onSubmit,
}: ComposerReplyOptions<Result>) {
  const target = useReplyTarget(sessionId)

  // Bring the composer forward once a reply starts
  useEffect(() => {
    if (!target) return
    const frame = requestAnimationFrame(() =>
      composerRef.current?.focus({ preventScroll: true }),
    )
    return () => cancelAnimationFrame(frame)
  }, [target, composerRef])

  const cancel = useCallback(() => {
    if (sessionId) clearReplyTarget(sessionId)
  }, [sessionId])

  const submit = useCallback(
    async (message: PendingMessage) => {
      if (!sessionId) return onSubmit(message)

      // A retried message keeps the quote it was first sent with
      const replyTo = message.replyTo ?? takeReplyTarget(sessionId)
      try {
        return await onSubmit(replyTo ? { ...message, replyTo } : message)
      } catch (error) {
        // The draft comes back on failure, so its quote does too
        const replyStartedSince = getReplyTarget(sessionId) !== undefined
        if (replyTo && !replyStartedSince) setReplyTarget(sessionId, replyTo)
        throw error
      }
    },
    [sessionId, onSubmit],
  )

  return { target, cancel, submit }
}
