/* global self, caches, URL, Response */

// This standalone worker shares its wire values with core/notification-actions.
const APP_ID = 'corvori'
const ACTION_CACHE = `${APP_ID}-notification-actions-v3`
const ACTION_PATH = '/__notification_actions__/'
const APPROVAL_ACTIONS = new Set(['allow', 'allow-session', 'deny'])

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

// Retain the selected action until an authenticated page acknowledges it.
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const { userId, notificationId, sessionId, taskRunId } =
    event.notification.data || {}
  if (typeof userId !== 'string' || !userId || !notificationId) return
  const action = event.action === 'dismiss' ? 'read' : event.action || 'show'
  if (action !== 'read' && action !== 'show' && !APPROVAL_ACTIONS.has(action))
    return
  event.waitUntil(
    deliverAction({
      type: `${APP_ID}:notification-action`,
      action,
      userId,
      notificationId,
      sessionId,
      taskRunId,
      requestId: `${notificationId}:${action}`,
    }),
  )
})

self.addEventListener('message', (event) => {
  if (event.data?.type !== `${APP_ID}:notification-action-ack`) return
  const { requestId, userId, focus } = event.data
  if (typeof requestId !== 'string' || typeof userId !== 'string') return
  event.waitUntil(
    caches.open(`${ACTION_CACHE}:${userId}`).then(async (cache) => {
      if ((await cache.delete(actionUrl(requestId))) && focus) {
        await event.source?.focus?.()
      }
    }),
  )
})

function actionUrl(requestId) {
  return new URL(
    `${ACTION_PATH}${encodeURIComponent(requestId)}`,
    self.location.origin,
  )
}

/** Chooses one page so background approvals do not run in every tab. */
async function deliverAction(action) {
  const windows = await self.clients.matchAll({
    type: 'window',
    includeUncontrolled: true,
  })
  const client =
    windows.find((window) => window.focused) ||
    windows.find((window) => window.visibilityState === 'visible') ||
    windows[0]
  // If there is no page, mark the action so the owner can open its chat after auth.
  const openSession = !client && action.action !== 'read' && !!action.sessionId
  const cache = await caches.open(`${ACTION_CACHE}:${action.userId}`)
  await cache.put(
    actionUrl(action.requestId),
    new Response(
      JSON.stringify(openSession ? { ...action, openSession } : action),
    ),
  )
  if (client) {
    client.postMessage(action)
    return
  }
  // Dismiss stays quiet; approval clicks open a page to authenticate and apply it.
  if (action.action === 'read' || !action.sessionId) return
  return self.clients.openWindow(new URL('/', self.location.origin).href)
}
