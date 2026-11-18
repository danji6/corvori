/// <reference types="bun-types" />
import type { Id } from '@cv/convex/_generated/dataModel'
import type { AuthQueryCtx } from '@cv/convex/functions'
import { insertUnreadNotification } from '@cv/convex/model/notificationRetention'
import {
  clearRead,
  discardSession,
  list,
  markAllRead,
  markManyRead,
  markRead,
  markSessionRead,
  notificationPreview,
  notificationPreviewFromParts,
  notifyAgentEvent,
  notifyUserMessage,
  removeForMembership,
  removeForSession,
} from '@cv/convex/model/notifications'
import { MAX_UNREAD_NOTIFICATIONS } from '@cv/core/limits'
import { describe, expect, test } from 'bun:test'
import { fakeCtx } from '~/tests/setup/notifications'

const session = {
  _id: 'session_1',
  _creationTime: 1,
  ownerId: 'user_1',
  title: 'Notifications',
}

const memberships = [
  {
    _id: 'membership_1',
    _creationTime: 2,
    sessionId: 'session_1',
    userId: 'user_1',
    role: 'owner',
  },
  {
    _id: 'membership_2',
    _creationTime: 3,
    sessionId: 'session_1',
    userId: 'user_2',
    role: 'member',
  },
]

describe('notification previews', () => {
  test('collapse whitespace and cap previews', () => {
    expect(notificationPreview('  hello\n   world  ', 'fallback')).toBe(
      'hello world',
    )
    expect(notificationPreview('x'.repeat(200), 'fallback')).toHaveLength(140)
  })

  test('reads only text parts and uses a textless fallback', () => {
    expect(
      notificationPreviewFromParts([
        { type: 'reasoning', text: 'secret' },
        { type: 'text', text: 'final\nanswer' },
      ]),
    ).toBe('final answer')
    expect(notificationPreviewFromParts([{ type: 'tool-shell' }])).toBe(
      'Turn completed',
    )
  })
})

describe('notification fan-out', () => {
  test('a user message reaches every member except its sender', async () => {
    const { ctx, rows } = fakeCtx({
      sessions: [session],
      userSessions: memberships,
    })

    await notifyUserMessage(ctx, {
      sessionId: 'session_1' as never,
      senderId: 'user_1' as never,
      actorName: 'Ada',
      preview: 'hello',
      sourceMessageId: 'message_1' as never,
    })

    expect(rows('notifications')).toEqual([
      expect.objectContaining({
        recipientId: 'user_2',
        kind: 'user_message',
        status: 'unread',
        sessionTitle: 'Notifications',
        preview: 'hello',
      }),
    ])
  })

  test('agent events reach all members but hidden child events are ignored', async () => {
    const agent = {
      _id: 'agent_1',
      _creationTime: 4,
      ownerId: 'user_1',
      name: 'Helper',
    }
    const { ctx, rows } = fakeCtx({
      sessions: [session],
      agents: [agent],
      userSessions: memberships,
    })

    await notifyAgentEvent(ctx, {
      sessionId: 'session_1' as never,
      agentId: 'agent_1' as never,
      kind: 'approval_required',
    })
    expect(rows('notifications').map((row) => row.recipientId)).toEqual([
      'user_1',
      'user_2',
    ])

    const child = {
      ...session,
      _id: 'session_child',
      parent: { sessionId: 'session_1' },
    }
    rows('sessions').push(child)
    await notifyAgentEvent(ctx, {
      sessionId: 'session_child' as never,
      agentId: 'agent_1' as never,
      kind: 'turn_completed',
    })
    expect(rows('notifications')).toHaveLength(2)
  })

  test('unread fan-out prunes older rows to 100', async () => {
    const notifications = Array.from(
      { length: MAX_UNREAD_NOTIFICATIONS - 1 },
      (_, index) => ({
        _id: `notification_${index}`,
        _creationTime: 100 + index,
        recipientId: 'user_2',
        sessionId: 'session_1',
        kind: 'user_message',
        status: 'unread',
        sessionTitle: 'Notifications',
        actorName: 'Ada',
      }),
    )
    const { ctx, rows } = fakeCtx({
      sessions: [session],
      userSessions: memberships,
      notifications,
    })

    const send = (preview: string) =>
      notifyUserMessage(ctx, {
        sessionId: 'session_1' as never,
        senderId: 'user_1' as never,
        actorName: 'Ada',
        sourceMessageId: 'message_1' as never,
        preview,
      })

    await send('fills inbox')
    const count = rows('notificationUnreadCounts')[0]
    expect(count.count).toBe(MAX_UNREAD_NOTIFICATIONS)
    expect(rows('notifications')).toHaveLength(MAX_UNREAD_NOTIFICATIONS)
    expect(rows('notifications')[0]._id).toBe(notifications[0]._id)

    await send('newest')
    expect(count.count).toBe(MAX_UNREAD_NOTIFICATIONS)
    expect(rows('notifications')).toHaveLength(MAX_UNREAD_NOTIFICATIONS)
    const inbox = await list(
      { ...(ctx as AuthQueryCtx), userId: 'user_2' as Id<'users'> },
      { status: 'unread' },
    )
    expect(inbox.slice(0, 2).map((row) => row.preview)).toEqual([
      'newest',
      'fills inbox',
    ])
    expect(inbox.at(-1)?._id as string).toBe(notifications[1]._id)
  })
})

describe('notification read lifecycle', () => {
  test('ordinary unread counts follow reads, discard and membership removal', async () => {
    const { ctx, rows } = fakeCtx()
    const sessionId = 'session_1' as Id<'sessions'>
    const recipientId = 'user_1' as Id<'users'>
    const add = (
      target = sessionId,
      recipient = recipientId,
      attention?: true,
    ) =>
      insertUnreadNotification(ctx, {
        sessionId: target,
        recipientId: recipient,
        kind: attention ? 'input_required' : 'user_message',
        sessionTitle: 'Test',
        actorName: 'Ada',
        attention,
      })

    const otherSession = 'session_2' as Id<'sessions'>
    const otherRecipient = 'user_2' as Id<'users'>
    await add()
    await add()
    await add(otherSession)
    await add(otherSession, otherRecipient)
    await add(sessionId, recipientId, true)
    const [first, second] = rows('notifications').map(
      (row) => row._id as Id<'notifications'>,
    )
    const counts = () =>
      rows('notificationUnreadCounts').map((row) => row.count)
    expect(counts()).toEqual([3, 1])

    await markRead(ctx, { notificationId: first })
    await markManyRead(ctx, { notificationIds: [first, second, second] })
    expect(counts()).toEqual([1, 1])

    await add()
    await markSessionRead(ctx, { sessionId })
    await markAllRead(ctx)
    expect(counts()).toEqual([0, 1])

    await add()
    await discardSession(ctx, { sessionId })
    expect(rows('notifications').filter((row) => row.attention)).toHaveLength(1)
    expect(counts()).toEqual([0, 1])

    await add()
    await add(otherSession)
    await removeForMembership(ctx, recipientId, sessionId)
    expect(counts()).toEqual([1, 1])
    await removeForSession(ctx, otherSession)
    expect(counts()).toEqual([0, 0])
  })

  test('bulk marking keeps the newest read rows and leaves protected requests unread', async () => {
    const notifications = Array.from({ length: 56 }, (_, index) => ({
      _id: `notification_${index}`,
      _creationTime: index + 1,
      recipientId: 'user_1',
      sessionId: 'session_1',
      kind: 'user_message',
      status: 'unread',
      sessionTitle: 'Notifications',
      actorName: 'Ada',
      ...(index === 55 && { attention: true }),
    }))
    const { ctx, rows } = fakeCtx({ notifications })

    await markManyRead(ctx, {
      notificationIds: notifications.map(({ _id }) => _id as never),
    })

    const history = await list(ctx, { status: 'read' })
    expect(history.map(({ _id }) => String(_id))).toEqual(
      notifications
        .slice(5, 55)
        .reverse()
        .map(({ _id }) => _id),
    )
    expect(rows('notifications').find((row) => row.attention)).toMatchObject({
      status: 'unread',
      attention: true,
    })
  })

  test('marking all read keeps only the 50 newest read rows', async () => {
    const notifications = Array.from({ length: 55 }, (_, index) => ({
      _id: `notification_${index}`,
      _creationTime: 100 + index,
      recipientId: 'user_1',
      sessionId: 'session_1',
      kind: 'user_message',
      status: 'unread',
      sessionTitle: 'Notifications',
      actorName: 'Ada',
    }))
    const { ctx, rows } = fakeCtx({ notifications })

    await markAllRead(ctx)

    expect(rows('notifications')).toHaveLength(50)
    expect(rows('notifications').every((row) => row.status === 'read')).toBe(
      true,
    )
    expect(
      rows('notifications').some((row) => row._id === 'notification_0'),
    ).toBe(false)
  })

  test('single, session, discard, list, and clear operations stay scoped', async () => {
    const notifications = [
      {
        _id: 'notification_1',
        _creationTime: 1,
        recipientId: 'user_1',
        sessionId: 'session_1',
        kind: 'user_message',
        status: 'unread',
        sessionTitle: 'One',
        actorName: 'Ada',
      },
      {
        _id: 'notification_2',
        _creationTime: 2,
        recipientId: 'user_1',
        sessionId: 'session_2',
        kind: 'turn_completed',
        status: 'unread',
        sessionTitle: 'Two',
        actorName: 'Bot',
      },
      {
        _id: 'notification_other',
        _creationTime: 3,
        recipientId: 'user_2',
        sessionId: 'session_1',
        kind: 'user_message',
        status: 'unread',
        sessionTitle: 'One',
        actorName: 'Other',
      },
    ]
    const { ctx, rows } = fakeCtx({ notifications })

    await markRead(ctx, { notificationId: 'notification_1' as never })
    await markSessionRead(ctx, { sessionId: 'session_2' as never })
    expect(await list(ctx, { status: 'read' })).toHaveLength(2)

    await discardSession(ctx, { sessionId: 'session_1' as never })
    expect(
      rows('notifications').some((row) => row._id === 'notification_other'),
    ).toBe(true)

    await clearRead(ctx)
    expect(rows('notifications')).toEqual([
      expect.objectContaining({ _id: 'notification_other' }),
    ])
  })
})
