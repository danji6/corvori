import {
  clearRead,
  discardSession,
  list,
  markAllRead,
  markRead,
  markSessionRead,
  notifyUserMessage,
} from '@cv/convex/model/notifications/records'
import {
  acknowledge,
  pendingPage,
  settleRequest,
  settleStream,
  summary,
} from '@cv/convex/model/notifications/requests'
import { describe, expect, test } from 'bun:test'
import { type Row, fakeCtx } from '~/tests/setup/notifications'

const request = {
  streamId: 'stream',
  messageId: 'message',
  contentId: 'content',
  toolCallId: 'call',
}
function notification(index: number, recipientId = 'user_1'): Row {
  return {
    _id: `notification_${recipientId}_${index}`,
    _creationTime: index,
    recipientId,
    sessionId: 'session',
    sessionTitle: 'Queue',
    actorName: 'Ada',
    kind: 'input_required',
    status: 'unread',
    attention: true,
    requestState: 'pending',
    request: { ...request, toolCallId: `call_${index}` },
  }
}

describe('durable notification queue', () => {
  test('pending requests survive read, discard, clear and ordinary retention overflow', async () => {
    const notifications = Array.from({ length: 125 }, (_, index) =>
      notification(index),
    )
    const { ctx, rows } = fakeCtx({
      notifications,
      sessions: [{ _id: 'session', _creationTime: 0 }],
      userSessions: [
        {
          _id: 'member',
          _creationTime: 0,
          sessionId: 'session',
          userId: 'user_1',
        },
      ],
    })
    for (let index = 0; index < 105; index++)
      await notifyUserMessage(ctx, {
        sessionId: 'session' as never,
        senderId: 'other' as never,
        actorName: 'Other',
        preview: 'Activity',
        sourceMessageId: 'message' as never,
      })
    const protectedRequests = await summary(ctx)
    expect(protectedRequests.attentionCount).toBe(125)
    expect(protectedRequests.pendingIds.map(String)).toEqual(
      notifications.map((row) => row._id),
    )
    expect(await list(ctx, { status: 'unread' })).toHaveLength(100)
    await markRead(ctx, { notificationId: notifications[0]._id as never })
    await markAllRead(ctx)
    await markSessionRead(ctx, { sessionId: 'session' as never })
    await discardSession(ctx, { sessionId: 'session' as never })
    await clearRead(ctx)
    expect(rows('notifications')).toHaveLength(125)
    expect(
      rows('notifications').every(
        (row) => row.status === 'unread' && row.requestState === 'pending',
      ),
    ).toBe(true)
  })

  test('pagination reaches every request oldest first, while summary returns newest candidates', async () => {
    const { ctx } = fakeCtx({
      notifications: Array.from({ length: 80 }, (_, index) =>
        notification(index),
      ).reverse(),
    })
    const ids: string[] = []
    let cursor: string | null = null
    do {
      const result = await pendingPage(ctx, {
        state: 'pending',
        paginationOpts: { numItems: 25, cursor },
      })
      ids.push(...result.page.map((row) => row._id))
      if (result.isDone) break
      cursor = result.continueCursor
    } while (cursor)
    expect(ids).toEqual(
      Array.from({ length: 80 }, (_, index) => `notification_user_1_${index}`),
    )
    const result = await summary(ctx)
    expect(result.pendingCount).toBe(80)
    expect(result.attentionCount).toBe(80)
    expect(String(result.recent[0]._id)).toBe('notification_user_1_79')
  })

  test('settling one invocation resolves every recipient without touching a replacement', async () => {
    const first = notification(1)
    const other = notification(1, 'user_2')
    const replacement = {
      ...notification(2),
      request: { ...(first.request as object), contentId: 'replacement' },
    }
    const { ctx, rows } = fakeCtx({
      notifications: [first, other, replacement],
    })
    await settleRequest(ctx, { ...request, toolCallId: 'call_1' } as never)
    await settleRequest(ctx, { ...request, toolCallId: 'call_1' } as never)
    expect(rows('notifications').map((row) => row.requestState)).toEqual([
      'handled',
      'handled',
      'pending',
    ])
    expect(rows('notifications')[2].attention).toBe(true)
  })

  test('bulk settlement retains the newest read entries for each recipient', async () => {
    const first = Array.from({ length: 55 }, (_, index) => notification(index))
    const second = notification(1, 'user_2')
    const expired = { ...notification(99), requestState: 'expired' }
    const { ctx, rows } = fakeCtx({
      notifications: [...first, second, expired],
    })

    await settleStream(ctx, 'stream' as never, 'handled')

    const read = await list(ctx, { status: 'read' })
    expect(read.map((row) => String(row._id))).toEqual(
      first
        .slice(5)
        .reverse()
        .map(({ _id }) => _id),
    )
    expect(rows('notifications')).toHaveLength(52)
    expect(rows('notifications')).toContainEqual(expired)
    expect(
      rows('notifications').find((row) => row._id === second._id),
    ).toMatchObject({ status: 'read', requestState: 'handled' })
  })

  test('expired requests remain protected until explicit acknowledgement', async () => {
    const { ctx, rows } = fakeCtx({ notifications: [notification(1)] })
    await settleStream(ctx, 'stream' as never, 'expired')
    await settleStream(ctx, 'stream' as never, 'unavailable')
    await markAllRead(ctx)
    await discardSession(ctx, { sessionId: 'session' as never })
    await clearRead(ctx)
    expect(rows('notifications')[0]).toMatchObject({
      requestState: 'expired',
      attention: true,
      status: 'unread',
    })
    expect(await summary(ctx)).toMatchObject({
      attentionCount: 1,
      pendingCount: 0,
      pendingIds: [],
    })
    await acknowledge(ctx, { notificationId: 'notification_user_1_1' as never })
    expect((await summary(ctx)).attentionCount).toBe(0)
    await clearRead(ctx)
    expect(rows('notifications')).toHaveLength(0)
  })

  test('acknowledgement enforces ownership and cannot dismiss pending requests', async () => {
    const { ctx, rows } = fakeCtx({
      notifications: [notification(1), notification(2, 'user_2')],
    })
    await acknowledge(ctx, { notificationId: 'notification_user_1_1' as never })
    expect(rows('notifications')[0].attention).toBe(true)
    await expect(
      acknowledge(ctx, { notificationId: 'notification_user_2_2' as never }),
    ).rejects.toThrow('Not found')
  })

  test('acknowledging an expired request enforces read retention once', async () => {
    const expired = { ...notification(50), requestState: 'expired' }
    const history = Array.from({ length: 50 }, (_, index) => ({
      ...notification(index),
      attention: undefined,
      status: 'read',
      readAt: index,
      requestState: 'handled',
    }))
    const { ctx, rows } = fakeCtx({ notifications: [...history, expired] })

    await acknowledge(ctx, { notificationId: expired._id as never })
    const acknowledged = rows('notifications').find(
      (row) => row._id === expired._id,
    )
    expect(acknowledged).toMatchObject({ status: 'read', attention: undefined })
    const readAt = acknowledged!.readAt
    await acknowledge(ctx, { notificationId: expired._id as never })

    expect(acknowledged!.readAt).toBe(readAt)
    expect(rows('notifications')).toHaveLength(50)
    expect(
      rows('notifications').some((row) => row._id === history[0]._id),
    ).toBe(false)
  })
})
