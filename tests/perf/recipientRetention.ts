import type { Doc, Id } from '@cv/convex/_generated/dataModel'
import type { MutationCtx } from '@cv/convex/_generated/server'
import { ordinaryNotifications } from '@cv/convex/model/notificationRetention'
import { MAX_UNREAD_NOTIFICATIONS } from '@cv/core/limits'

type OrdinaryNotification = Pick<
  Doc<'notifications'>,
  | 'sessionId'
  | 'sourceMessageId'
  | 'sessionTitle'
  | 'actorName'
  | 'actorAvatarId'
  | 'preview'
>

/** Insert ordered deliveries and update ordinary unread retention once. */
export async function insertOrdinaryBatch(
  ctx: MutationCtx,
  recipientId: Id<'users'>,
  notifications: OrdinaryNotification[],
) {
  if (!notifications.length) return

  const count = await ctx.db
    .query('notificationUnreadCounts')
    .withIndex('by_recipientId', (q) => q.eq('recipientId', recipientId))
    .unique()
  for (const notification of notifications) {
    await ctx.db.insert('notifications', {
      ...notification,
      recipientId,
      kind: 'user_message',
      status: 'unread',
    })
  }
  if (!count) {
    const rows = await ordinaryNotifications(
      ctx,
      recipientId,
      'unread',
    ).collect()
    for (const row of rows.slice(MAX_UNREAD_NOTIFICATIONS))
      await ctx.db.delete(row._id)
    await ctx.db.insert('notificationUnreadCounts', {
      recipientId,
      count: Math.min(rows.length, MAX_UNREAD_NOTIFICATIONS),
    })
    return
  }

  const total = count.count + notifications.length
  const overflow = total - MAX_UNREAD_NOTIFICATIONS
  if (overflow > 0) {
    const oldest = await ordinaryNotifications(
      ctx,
      recipientId,
      'unread',
      'asc',
    ).take(overflow)
    for (const row of oldest) await ctx.db.delete(row._id)
  }
  const retained = Math.min(total, MAX_UNREAD_NOTIFICATIONS)
  if (retained !== count.count)
    await ctx.db.patch(count._id, { count: retained })
}
