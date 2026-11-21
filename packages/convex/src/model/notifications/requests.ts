import type { PaginationOptions } from 'convex/server'

import type { Doc, Id } from '../../_generated/dataModel'
import type { MutationCtx } from '../../_generated/server'
import { error } from '../../errors'
import type { AuthMutationCtx, AuthQueryCtx } from '../../functions'
import type { NotificationRequest, NotificationRequestState } from '../../types'
import { withApprovalActions } from './approvals'
import { pruneReadNotifications } from './retention'

type PendingPageArgs = {
  paginationOpts: PaginationOptions
  state: 'pending' | 'expired'
}

/** Lists protected requests without applying ordinary inbox retention limits. */
export async function pendingPage(
  ctx: AuthQueryCtx,
  { paginationOpts, state }: PendingPageArgs,
) {
  const result = await ctx.db
    .query('notifications')
    .withIndex('by_recipientId_attention', (q) =>
      q
        .eq('recipientId', ctx.userId)
        .eq('attention', true)
        .eq('requestState', state),
    )
    .order('asc')
    .paginate(paginationOpts)
  return {
    ...result,
    page: await Promise.all(
      result.page.map((row) => withApprovalActions(ctx, row)),
    ),
  }
}

/** Summarizes protected requests independently of the loaded inbox pages. */
export async function summary(ctx: AuthQueryCtx) {
  const attention = await attentionRows(ctx).collect()
  const pending = attention.filter((row) => row.requestState === 'pending')

  const recent = [...pending]
    .sort(
      (a, b) => b._creationTime - a._creationTime || b._id.localeCompare(a._id),
    )
    .slice(0, 100)

  return {
    attentionCount: attention.length,
    pendingCount: pending.length,
    pendingIds: pending.map((row) => row._id),
    recent: await Promise.all(
      recent.map((row) => withApprovalActions(ctx, row)),
    ),
  }
}

function attentionRows(ctx: AuthQueryCtx) {
  return ctx.db
    .query('notifications')
    .withIndex('by_recipientId_attention', (q) =>
      q.eq('recipientId', ctx.userId).eq('attention', true),
    )
}

/** Explicitly acknowledges an expired request; opening its chat is insufficient. */
export async function acknowledge(
  ctx: AuthMutationCtx,
  { notificationId }: { notificationId: Id<'notifications'> },
) {
  const row = await ctx.db.get(notificationId)
  if (!row || row.recipientId !== ctx.userId) error('Not found', 404)
  if (!row.attention || row.requestState !== 'expired') return
  await ctx.db.patch(row._id, {
    attention: undefined,
    status: 'read',
    readAt: Date.now(),
  })
  await pruneReadNotifications(ctx, ctx.userId)
}

/** Matches the exact processing segment and invocation behind a request. */
function sameInvocation(
  left: NotificationRequest | undefined,
  right: NotificationRequest,
) {
  return (
    left?.streamId === right.streamId &&
    left.messageId === right.messageId &&
    left.contentId === right.contentId &&
    left.toolCallId === right.toolCallId
  )
}

/** Prevents repeated parking from creating another copy for the same recipient. */
export async function hasRequest(
  ctx: MutationCtx,
  recipientId: Id<'users'>,
  request: NotificationRequest,
) {
  const rows = await forStream(ctx, request.streamId)
  return rows.some(
    (row) =>
      row.recipientId === recipientId && sameInvocation(row.request, request),
  )
}

/** Settles every recipient's copy of a particular invocation in the same transaction. */
export async function settleRequest(
  ctx: MutationCtx,
  target: NotificationRequest,
  state: Exclude<NotificationRequestState, 'pending'> = 'handled',
) {
  const rows = await forStream(ctx, target.streamId)
  await settle(
    ctx,
    rows.filter((row) => sameInvocation(row.request, target)),
    state,
  )
}

/** Settles protected requests before their stream is stopped or removed. */
export async function settleStream(
  ctx: MutationCtx,
  streamId: Id<'streams'>,
  state: Exclude<NotificationRequestState, 'pending'>,
) {
  await settle(ctx, await forStream(ctx, streamId), state)
}

function forStream(ctx: MutationCtx, streamId: Id<'streams'>) {
  return ctx.db
    .query('notifications')
    .withIndex('by_requestStreamId', (q) => q.eq('request.streamId', streamId))
    .collect()
}

async function settle(
  ctx: MutationCtx,
  rows: Doc<'notifications'>[],
  state: Exclude<NotificationRequestState, 'pending'>,
) {
  const expired = state === 'expired'
  const recipients = new Set<Id<'users'>>()
  const readAt = expired ? undefined : Date.now()
  for (const row of rows) {
    if (row.requestState !== 'pending') continue
    await ctx.db.patch(row._id, {
      requestState: state,
      attention: expired ? true : undefined,
      status: expired ? 'unread' : 'read',
      readAt,
    })
    if (!expired) recipients.add(row.recipientId)
  }
  for (const recipientId of recipients)
    await pruneReadNotifications(ctx, recipientId)
}
