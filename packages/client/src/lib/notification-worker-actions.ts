import {
  NOTIFICATION_ACTION,
  NOTIFICATION_ACTION_ACK,
  NOTIFICATION_ACTION_CACHE,
  type NotificationWorkerAction,
} from '@cv/core/notification-actions'

export type ApplyWorkerAction = (
  action: NotificationWorkerAction,
) => Promise<void>

/** Accepts only known notification actions from the service worker. */
export function isWorkerAction(
  value: unknown,
): value is NotificationWorkerAction {
  if (!value || typeof value !== 'object') return false
  const action = value as NotificationWorkerAction
  return (
    action.type === NOTIFICATION_ACTION &&
    typeof action.userId === 'string' &&
    action.userId.length > 0 &&
    typeof action.notificationId === 'string' &&
    ['read', 'show', 'allow', 'allow-session', 'deny'].includes(action.action)
  )
}

/** Applies durable clicks after authentication; failed actions remain retryable. */
export async function drainPendingWorkerActions(
  userId: string,
  apply: ApplyWorkerAction,
  signal?: AbortSignal,
) {
  if (!('caches' in window)) return
  const cache = await caches.open(`${NOTIFICATION_ACTION_CACHE}:${userId}`)
  const failures: unknown[] = []
  for (const request of await cache.keys()) {
    if (signal?.aborted) break
    const response = await cache.match(request)
    const action: unknown = await response?.json().catch(() => null)
    if (!isWorkerAction(action)) {
      await cache.delete(request)
      continue
    }
    if (action.userId !== userId || signal?.aborted) continue
    try {
      await apply(action)
      if (!signal?.aborted) await cache.delete(request)
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length)
    throw new AggregateError(
      failures,
      'Some notification actions could not be applied',
    )
}

/** Clears a delivered action only after the server has handled it. */
export function acknowledgeWorkerAction(action: NotificationWorkerAction) {
  if (!action.requestId) return
  navigator.serviceWorker.controller?.postMessage({
    type: NOTIFICATION_ACTION_ACK,
    requestId: action.requestId,
    userId: action.userId,
    focus: action.action === 'show',
  })
}
