import { drainPendingWorkerActions } from '@/lib/notification-worker-actions'
import {
  type NotificationApprovalOption,
  desktopApprovalActions,
} from '@cv/core/notification-actions'
import { expect, mock, test } from 'bun:test'

function pendingCache(value: unknown) {
  const url = 'https://example.test/__notification_actions__/notification'
  const entries = new Map(value === undefined ? [] : [[url, value]])
  return {
    entries,
    keys: async () => [...entries.keys()].map((key) => new Request(key)),
    match: async (request: Request) =>
      entries.has(request.url)
        ? Response.json(entries.get(request.url))
        : undefined,
    delete: async (request: Request) => entries.delete(request.url),
  }
}

test('queued session approval survives a failed attempt and retains its selected action', async () => {
  const cache = pendingCache({
    type: 'corvori:notification-action',
    action: 'allow-session',
    userId: 'owner',
    notificationId: 'notification',
    sessionId: 'session',
  })
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const previousCaches = Object.getOwnPropertyDescriptor(globalThis, 'caches')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { caches: true },
  })
  Object.defineProperty(globalThis, 'caches', {
    configurable: true,
    value: {
      open: async (key: string) =>
        key.endsWith(':owner') ? cache : pendingCache(undefined),
    },
  })
  try {
    const wrongAccount = mock(async () => undefined)
    await drainPendingWorkerActions('other', wrongAccount)
    expect(wrongAccount).not.toHaveBeenCalled()
    expect(cache.entries.size).toBe(1)

    await expect(
      drainPendingWorkerActions('owner', async () => {
        throw new Error('offline')
      }),
    ).rejects.toThrow('offline')
    expect(cache.entries.size).toBe(1)
    cache.entries.set('https://example.test/__notification_actions__/second', {
      type: 'corvori:notification-action',
      action: 'allow-session',
      userId: 'owner',
      notificationId: 'second',
      sessionId: 'session',
    })
    const completed: string[] = []
    await expect(
      drainPendingWorkerActions('owner', async (action) => {
        if (action.notificationId === 'notification') throw new Error('offline')
        completed.push(action.notificationId)
      }),
    ).rejects.toThrow('offline')
    expect(completed).toEqual(['second'])
    expect(cache.entries.size).toBe(1)
    const apply = mock(async () => undefined)
    await drainPendingWorkerActions('owner', apply)
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'allow-session' }),
    )
    expect(cache.entries.size).toBe(0)
  } finally {
    if (previousWindow)
      Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
    if (previousCaches)
      Object.defineProperty(globalThis, 'caches', previousCaches)
    else Reflect.deleteProperty(globalThis, 'caches')
  }
})

test('desktop actions respect platform limits and prioritize the requested allow choices', () => {
  const options: NotificationApprovalOption[] = [
    { action: 'allow', label: 'Allow' },
    { action: 'allow-session', label: 'Allow for this session' },
    { action: 'deny', label: 'Deny' },
  ]
  expect(desktopApprovalActions(options, 0)).toEqual([])
  expect(desktopApprovalActions(options, 1)).toEqual([
    { action: 'allow', title: 'Allow' },
  ])
  expect(
    desktopApprovalActions(options, 2).map((action) => action.title),
  ).toEqual(['Allow', 'Allow for this session'])
  expect(
    desktopApprovalActions(options, 3).map((action) => action.title),
  ).toEqual(['Allow', 'Allow for this session', 'Deny'])
})
