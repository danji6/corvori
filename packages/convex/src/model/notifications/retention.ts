import {
  MAX_READ_NOTIFICATIONS,
  MAX_UNREAD_NOTIFICATIONS,
} from '@cv/core/limits'

import type { Doc, Id } from '../../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../../_generated/server'
import type { NotificationStatus } from '../../validators/notifications'

export function statusLimit(status: NotificationStatus) {
  return status === 'unread' ? MAX_UNREAD_NOTIFICATIONS : MAX_READ_NOTIFICATIONS
}

/** Orders ordinary inbox entries by read time and then creation time. */
export function ordinaryNotifications(
  ctx: MutationCtx | QueryCtx,
  recipientId: Id<'users'>,
  status: NotificationStatus,
  order: 'asc' | 'desc' = 'desc',
) {
  return ctx.db
    .query('notifications')
    .withIndex('by_recipient_status_attention_readAt', (q) =>
      q
        .eq('recipientId', recipientId)
        .eq('status', status)
        .eq('attention', undefined),
    )
    .order(order)
}

/** Retains the newest ordinary read entries after a read or request settlement. */
export async function pruneReadNotifications(
  ctx: MutationCtx,
  recipientId: Id<'users'>,
) {
  const rows = await ordinaryNotifications(ctx, recipientId, 'read').collect()
  for (const row of rows.slice(MAX_READ_NOTIFICATIONS)) {
    await ctx.db.delete(row._id)
  }
}

type NewNotification = Omit<
  Doc<'notifications'>,
  '_id' | '_creationTime' | 'status'
>

/** Inserts an unread notification and retains the newest ordinary entries. */
export async function insertUnreadNotification(
  ctx: MutationCtx,
  notification: NewNotification,
) {
  await ctx.db.insert('notifications', { ...notification, status: 'unread' })
  if (notification.attention) return

  const { recipientId } = notification
  const count = await unreadCount(ctx, recipientId)

  if (!count) {
    const rows = await ordinaryNotifications(
      ctx,
      recipientId,
      'unread',
    ).collect()
    for (const row of rows.slice(MAX_UNREAD_NOTIFICATIONS)) {
      await ctx.db.delete(row._id)
    }
    await ctx.db.insert('notificationUnreadCounts', {
      recipientId,
      count: Math.min(rows.length, MAX_UNREAD_NOTIFICATIONS),
    })
  } else if (count.count < MAX_UNREAD_NOTIFICATIONS) {
    await ctx.db.patch(count._id, { count: count.count + 1 })
  } else {
    const oldest = await ordinaryNotifications(
      ctx,
      recipientId,
      'unread',
      'asc',
    ).first()
    if (oldest) await ctx.db.delete(oldest._id)
  }
}

/** Decrements initialized counts after ordinary entries leave the unread inbox. */
export async function recordUnreadRemovals(
  ctx: MutationCtx,
  rows: Doc<'notifications'>[],
) {
  const removals = new Map<Id<'users'>, number>()
  for (const row of rows) {
    if (isOrdinaryUnread(row)) {
      const { recipientId } = row
      removals.set(recipientId, (removals.get(recipientId) ?? 0) + 1)
    }
  }
  for (const [recipientId, removed] of removals) {
    const count = await unreadCount(ctx, recipientId)
    if (count) await ctx.db.patch(count._id, { count: count.count - removed })
  }
}

export function isOrdinaryUnread(row: Doc<'notifications'>) {
  return row.status === 'unread' && !row.attention
}

function unreadCount(ctx: MutationCtx, recipientId: Id<'users'>) {
  return ctx.db
    .query('notificationUnreadCounts')
    .withIndex('by_recipientId', (q) => q.eq('recipientId', recipientId))
    .unique()
}
