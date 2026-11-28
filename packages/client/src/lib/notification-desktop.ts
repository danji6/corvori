import {
  type NotificationItem,
  notificationBody,
  notificationTag,
} from '@/lib/chat/notification-ui'
import { APP_ID, APP_NAME } from '@cv/core/const'
import { desktopApprovalActions } from '@cv/core/notification-actions'

/** Shows a native notification when browser permission allows it. */
export async function showDesktopNotification(
  userId: string,
  notification: NotificationItem,
  isCurrent = () => true,
) {
  if (!supportsDesktopNotifications() || Notification.permission !== 'granted')
    return

  const registration = await registerNotificationWorker()
  if (!isCurrent()) return

  const maxActions =
    (Notification as typeof Notification & { maxActions?: number })
      .maxActions ?? 2

  const options: NotificationOptions & {
    actions: Array<{ action: string; title: string }>
  } = {
    body: notificationBody(notification),
    requireInteraction: notification.requestState === 'pending',
    icon: '/favicon.png',
    tag: notificationTag(userId, notification._id),
    data: {
      userId,
      notificationId: notification._id,
      sessionId: notification.sessionId,
      taskRunId: notification.taskRunId,
    },
    actions: notification.approvalActions?.length
      ? desktopApprovalActions(notification.approvalActions, maxActions)
      : [{ action: 'dismiss', title: 'Dismiss' }],
  }

  const title = `${APP_NAME} · ${notification.actorName}`
  await registration.showNotification(title, options)
  return true
}

/** Closes the native alert associated with a notification record. */
export async function closeDesktopNotification(
  userId: string,
  notificationId: string,
) {
  if (!('serviceWorker' in navigator)) return
  const registration = await navigator.serviceWorker.getRegistration()
  const notifications = await registration?.getNotifications({
    tag: notificationTag(userId, notificationId),
  })
  notifications?.forEach((notification) => notification.close())
}

let workerRegistration: Promise<ServiceWorkerRegistration> | null = null

/** Registers the worker that handles native notification actions. */
export function registerNotificationWorker() {
  workerRegistration ??= navigator.serviceWorker
    .register('/notification-worker.js')
    .catch((error) => {
      workerRegistration = null
      throw error
    })
  return workerRegistration
}

export function supportsDesktopNotifications() {
  return (
    window.isSecureContext &&
    'Notification' in window &&
    'serviceWorker' in navigator
  )
}

const DELIVERY_KEY = `${APP_ID}:desktop-delivery`

function deliveredNotifications(key: string): Record<string, number> {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? '{}')
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value
      : {}
  } catch {
    return {}
  }
}

/** Suppresses replay across reloads and serializes delivery between browser tabs. */
export async function showDesktopNotificationOnce(
  userId: string,
  notification: NotificationItem,
  isCurrent: () => boolean,
) {
  const key = `${DELIVERY_KEY}:${userId}`
  const deliver = async () => {
    const delivered = deliveredNotifications(key)
    if (delivered[notification._id]) return
    if (!(await showDesktopNotification(userId, notification, isCurrent)))
      return
    delivered[notification._id] = Date.now()
    const bounded = Object.fromEntries(
      Object.entries(delivered)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 1000),
    )
    try {
      localStorage.setItem(key, JSON.stringify(bounded))
    } catch {
      /* Desktop deduplication is best effort; requests remain on the server. */
    }
  }
  if (navigator.locks) await navigator.locks.request(key, deliver)
  else await deliver()
}

/** Closes settled or currently viewed banners, including those delivered by other tabs. */
export async function closeInactiveDesktopNotifications(
  userId: string,
  activeIds: string[],
  viewedSessionId: string | null = null,
) {
  if (!('serviceWorker' in navigator)) return
  const registration = await navigator.serviceWorker.getRegistration()
  const notifications = await registration?.getNotifications()
  const active = new Set(activeIds)
  for (const notification of notifications ?? []) {
    if (notification.data?.userId !== userId) continue
    const id = notification.data?.notificationId
    const viewed =
      viewedSessionId !== null &&
      notification.data?.sessionId === viewedSessionId
    const settled = typeof id === 'string' && !active.has(id)
    if (viewed || settled) notification.close()
  }
}

/** Closes delivered banners when the user disables desktop delivery. */
export async function closeAllDesktopNotifications(userId: string) {
  if (!('serviceWorker' in navigator)) return
  const registration = await navigator.serviceWorker.getRegistration()
  const notifications = await registration?.getNotifications()
  notifications
    ?.filter((notification) => notification.data?.userId === userId)
    .forEach((notification) => notification.close())
}
