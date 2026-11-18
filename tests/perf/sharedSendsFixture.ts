import type { Id } from '@cv/convex/_generated/dataModel'
import {
  type MutationCtx,
  internalMutation,
} from '@cv/convex/_generated/server'
import type { AuthMutationCtx } from '@cv/convex/functions'
import { insertUnreadNotification } from '@cv/convex/model/notificationRetention'
import {
  discardSession,
  notifyAgentEvent,
} from '@cv/convex/model/notifications'
import { MAX_UNREAD_NOTIFICATIONS } from '@cv/core/limits'
import { v } from 'convex/values'

const title = 'Shared send performance'
const users = v.array(v.id('users'))

export const _session = internalMutation({
  args: { userIds: users },
  handler: async (ctx, { userIds }) => {
    const ownerId = userIds[0]
    const sessionId = await ctx.db.insert('sessions', { ownerId, title })
    for (const userId of userIds) {
      await ctx.db.insert('userSessions', {
        userId,
        sessionId,
        title,
        role: userId === ownerId ? 'owner' : 'member',
        groupKey: 'ungrouped',
      })
    }
    return sessionId
  },
})

async function unread(ctx: MutationCtx, recipientId: Id<'users'>) {
  const rows = await ctx.db
    .query('notifications')
    .withIndex('by_recipientId_attention', (q) =>
      q.eq('recipientId', recipientId),
    )
    .collect()
  return rows.filter((row) => row.status === 'unread')
}

function unreadCount(ctx: MutationCtx, recipientId: Id<'users'>) {
  return ctx.db
    .query('notificationUnreadCounts')
    .withIndex('by_recipientId', (q) => q.eq('recipientId', recipientId))
    .unique()
}

export const _inbox = internalMutation({
  args: {
    recipientId: v.id('users'),
    sessionId: v.id('sessions'),
    ordinary: v.number(),
    protectedCount: v.number(),
    resetCount: v.boolean(),
  },
  handler: async (
    ctx,
    { recipientId, sessionId, ordinary, protectedCount, resetCount },
  ) => {
    // Seed an existing inbox without an initialized count for the first send.
    const count = resetCount ? await unreadCount(ctx, recipientId) : null
    if (count) await ctx.db.delete(count._id)
    for (const row of await unread(ctx, recipientId)) {
      await ctx.db.delete(row._id)
    }
    for (let i = 0; i < ordinary + protectedCount; i++) {
      const attention = i >= ordinary
      await ctx.db.insert('notifications', {
        recipientId,
        sessionId,
        status: 'unread',
        kind: attention ? 'input_required' : 'user_message',
        sessionTitle: title,
        actorName: 'Fixture',
        preview: 'Seeded inbox item',
        ...(attention && {
          attention: true,
          requestState: i % 2 ? 'pending' : 'expired',
        }),
      })
    }
  },
})

export const _verify = internalMutation({
  args: {
    sessionIds: v.array(v.id('sessions')),
    sends: v.array(
      v.object({
        sessionId: v.id('sessions'),
        messageId: v.id('messages'),
        senderId: v.id('users'),
      }),
    ),
    ordinary: v.number(),
    protectedCount: v.number(),
    reset: v.boolean(),
    checkCounts: v.boolean(),
    memberActivity: v.boolean(),
  },
  handler: async (ctx, args) => {
    const {
      sessionIds,
      sends,
      ordinary,
      protectedCount,
      reset,
      checkCounts,
      memberActivity,
    } = args
    const recipients = await checkActivity(ctx, sessionIds, memberActivity)
    for (const { messageId, sessionId } of sends) {
      const message = await ctx.db.get(messageId)
      if (message?.sessionId !== sessionId)
        throw new Error('Missing sent message')
    }
    for (const [userId, sessions] of recipients) {
      const rows = await unread(ctx, userId)
      const deliveries = sends.filter(
        ({ senderId, sessionId }) =>
          senderId !== userId && sessions.has(sessionId),
      )
      const kept = Math.min(
        ordinary + deliveries.length,
        MAX_UNREAD_NOTIFICATIONS,
      )
      if (
        rows.filter((row) => row.attention).length !== protectedCount ||
        rows.filter((row) => !row.attention).length !== kept
      ) {
        throw new Error('Inbox retention changed')
      }
      for (const send of sends) {
        const received = rows.filter(
          (row) => row.sourceMessageId === send.messageId,
        )
        if (received.length !== Number(deliveries.includes(send))) {
          throw new Error('Unexpected notification delivery count')
        }
      }
      if (reset) {
        for (const sessionId of sessions) {
          await discardSession({ ...ctx, userId } as AuthMutationCtx, {
            sessionId,
          })
        }
      }
      if (checkCounts && deliveries.length) {
        const count = await unreadCount(ctx, userId)
        if (count?.count !== (reset ? ordinary : kept)) {
          throw new Error('Unread count does not match retention')
        }
      }
    }
  },
})

export const _verifyRace = internalMutation({
  args: {
    recipientId: v.id('users'),
    expectedCount: v.number(),
    messageId: v.id('messages'),
  },
  handler: async (ctx, { recipientId, expectedCount, messageId }) => {
    const rows = await unread(ctx, recipientId)
    const ordinary = rows.filter((row) => !row.attention)
    const count = await unreadCount(ctx, recipientId)
    if (
      ordinary.length !== expectedCount ||
      count?.count !== expectedCount ||
      !ordinary.some((row) => row.sourceMessageId === messageId)
    ) {
      throw new Error(
        'Concurrent inbox change lost a notification or its count',
      )
    }
  },
})

async function checkActivity(
  ctx: MutationCtx,
  sessionIds: Id<'sessions'>[],
  memberActivity: boolean,
) {
  const recipients = new Map<Id<'users'>, Set<Id<'sessions'>>>()
  for (const sessionId of sessionIds) {
    const session = await ctx.db.get(sessionId)
    if (!session?.lastMessageAt) throw new Error('Missing session activity')
    const expected = memberActivity ? session.lastMessageAt : undefined
    const members = await ctx.db
      .query('userSessions')
      .withIndex('by_sessionId', (q) => q.eq('sessionId', sessionId))
      .collect()
    for (const { userId, lastMessageAt } of members) {
      if (lastMessageAt !== expected) {
        throw new Error('Unexpected member activity')
      }
      const sessions = recipients.get(userId) ?? new Set<Id<'sessions'>>()
      sessions.add(sessionId)
      recipients.set(userId, sessions)
    }
  }
  return recipients
}

export const _inspectInbox = internalMutation({
  args: { recipientId: v.id('users') },
  handler: async (ctx, { recipientId }) => {
    const rows = await ctx.db
      .query('notifications')
      .withIndex('by_recipientId_attention', (q) =>
        q.eq('recipientId', recipientId),
      )
      .order('asc')
      .collect()
    const count = await unreadCount(ctx, recipientId)
    return { rows, count: count?.count }
  },
})

export const _inspectMessages = internalMutation({
  args: { sessionIds: v.array(v.id('sessions')) },
  handler: async (ctx, { sessionIds }) => {
    const groups = await Promise.all(
      sessionIds.map((sessionId) =>
        ctx.db
          .query('messages')
          .withIndex('by_sessionId_position', (q) =>
            q.eq('sessionId', sessionId),
          )
          .collect(),
      ),
    )
    return groups
      .flat()
      .map(({ _id, _creationTime }) => ({ _id, _creationTime }))
  },
})

export const _removeSources = internalMutation({
  args: { messageId: v.id('messages'), sessionId: v.id('sessions') },
  handler: async (ctx, { messageId, sessionId }) => {
    await ctx.db.delete(messageId)
    await ctx.db.delete(sessionId)
  },
})

export const _rejoin = internalMutation({
  args: { recipientId: v.id('users'), sessionId: v.id('sessions') },
  handler: async (ctx, { recipientId, sessionId }) => {
    const member = await ctx.db
      .query('userSessions')
      .withIndex('by_sessionId_userId', (q) =>
        q.eq('sessionId', sessionId).eq('userId', recipientId),
      )
      .unique()
    if (!member) throw new Error('Missing original membership')
    const { _id, _creationTime, ...fields } = member
    await ctx.db.delete(_id)
    await ctx.db.insert('userSessions', fields)
  },
})

export const _agentActivity = internalMutation({
  args: { sessionId: v.id('sessions'), ownerId: v.id('users') },
  handler: async (ctx, { sessionId, ownerId }) => {
    const agentId = await ctx.db.insert('agents', {
      ownerId,
      name: 'Queue probe agent',
      tools: [],
    })
    await notifyAgentEvent(ctx, {
      sessionId,
      agentId,
      kind: 'turn_completed',
      preview: 'Agent queue probe',
    })
  },
})

export const _protectedActivity = internalMutation({
  args: { sessionId: v.id('sessions'), recipientId: v.id('users') },
  handler: (ctx, args) =>
    insertUnreadNotification(ctx, {
      ...args,
      kind: 'approval_required',
      preview: 'Protected queue probe',
      actorName: 'Queue probe agent',
      sessionTitle: title,
      attention: true,
      requestState: 'pending',
    }),
})
