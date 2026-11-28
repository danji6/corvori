import { useAccountId } from '@/hooks/account-scope'
import {
  registerNotificationWorker,
  supportsDesktopNotifications,
} from '@/lib/notification-desktop'
import {
  acknowledgeWorkerAction,
  drainPendingWorkerActions,
  isWorkerAction,
} from '@/lib/notification-worker-actions'
import { toastError } from '@/lib/notifications'
import { api } from '@cv/convex/_generated/api'
import type { Id } from '@cv/convex/_generated/dataModel'
import {
  type NotificationWorkerAction,
  notificationPath,
} from '@cv/core/notification-actions'
import { useMutation } from 'convex/react'
import { ConvexError } from 'convex/values'
import { useCallback, useEffect } from 'react'
import { useLocation } from 'wouter'

/** Replays durable desktop clicks for the authenticated account. */
export function useNotificationWorker() {
  const userId = useAccountId()
  const markManyRead = useMutation(api.notifications.markManyRead)
  const respond = useMutation(api.notifications.respondApproval)
  const [, navigate] = useLocation()

  const apply = useCallback(
    async (action: NotificationWorkerAction, signal: AbortSignal) => {
      if (signal.aborted || action.userId !== userId) return
      try {
        if (action.action === 'read' || action.action === 'show') {
          await markManyRead({
            notificationIds: [action.notificationId as Id<'notifications'>],
          })
        } else {
          await respond({
            notificationId: action.notificationId as Id<'notifications'>,
            action: action.action,
          })
        }
        if (
          !signal.aborted &&
          (action.action === 'show' || action.openSession === true) &&
          action.sessionId
        ) {
          navigate(notificationPath(action.sessionId, action.taskRunId))
          window.focus()
        }
      } catch (error) {
        const code = error instanceof ConvexError ? error.data?.code : undefined
        if (![403, 404, 409].includes(code)) throw error
        if (!signal.aborted) toastError(error)
      }
      if (!signal.aborted) acknowledgeWorkerAction(action)
    },
    [markManyRead, navigate, respond, userId],
  )

  useEffect(() => {
    if (!supportsDesktopNotifications()) return
    const controller = new AbortController()
    const { signal } = controller
    const inFlight = new Map<string, Promise<void>>()

    function handle(action: NotificationWorkerAction) {
      const key = action.requestId ?? action.notificationId
      const pending = inFlight.get(key)
      if (pending) return pending
      const result = apply(action, signal).finally(() => inFlight.delete(key))
      inFlight.set(key, result)
      return result
    }

    const onMessage = (event: MessageEvent<unknown>) => {
      if (isWorkerAction(event.data) && event.data.userId === userId) {
        void handle(event.data).catch(toastError)
      }
    }
    const drain = () => {
      void registerNotificationWorker()
        .then(() => drainPendingWorkerActions(userId, handle, signal))
        .catch(toastError)
    }

    navigator.serviceWorker.addEventListener('message', onMessage)
    window.addEventListener('focus', drain)
    drain()

    return () => {
      controller.abort()
      navigator.serviceWorker.removeEventListener('message', onMessage)
      window.removeEventListener('focus', drain)
    }
  }, [apply, userId])
}
