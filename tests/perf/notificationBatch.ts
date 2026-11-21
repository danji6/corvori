import type { Doc, Id } from '@cv/convex/_generated/dataModel'
import type { MutationCtx } from '@cv/convex/_generated/server'
import { notificationPreview } from '@cv/convex/model/notifications/records'
import { insertUnreadNotification } from '@cv/convex/model/notifications/retention'
import {
  type GenericDatabaseWriter,
  type GenericMutationCtx,
  type MutationBuilder,
  internalMutationGeneric,
  makeFunctionReference,
} from 'convex/server'
import { type GenericId, v } from 'convex/values'

import type { BatchModel } from './notificationBatchSchema'

type BatchCtx = GenericMutationCtx<BatchModel>
type BatchId = GenericId<'notificationBatches'>
const batchMutation: MutationBuilder<BatchModel, 'internal'> =
  internalMutationGeneric

type UserMessage = {
  sessionId: Id<'sessions'>
  sourceMessageId: Id<'messages'>
  senderId: Id<'users'>
  members: Doc<'userSessions'>[]
  actorName: string
  actorAvatarId?: Id<'avatars'>
  preview: string
}

const deliver = makeFunctionReference<'mutation', { batchId: BatchId }>(
  'notificationBatch:_deliver',
)

/** Enqueue in the same transaction as the message, on the copied deployment. */
export async function enqueueUserNotification(
  ctx: MutationCtx,
  args: UserMessage,
) {
  // Only the disposable deployment adds this table to the app's schema.
  const db = ctx.db as GenericDatabaseWriter<BatchModel>
  const batchId = await stage(db, args)
  if (batchId) await ctx.scheduler.runAfter(0, deliver, { batchId })
}

async function stage(
  db: GenericDatabaseWriter<BatchModel>,
  { senderId, members, preview, ...event }: UserMessage,
) {
  const memberships = members
    .filter((member) => member.userId !== senderId)
    .map((member) => member._id)
  if (!memberships.length) return null
  const session = await db.get(event.sessionId)
  if (!session) return null
  return db.insert('notificationBatches', {
    ...event,
    memberships,
    sessionTitle: session.title || session.firstMessagePreview || 'New chat',
    preview: notificationPreview(preview, 'Sent a message'),
  })
}

/** Commit the deliveries and consume the batch atomically. */
async function deliverBatch(ctx: BatchCtx, batchId: BatchId) {
  const batch = await ctx.db.get(batchId)
  if (!batch) return 0
  await ctx.db.delete(batchId)

  const { sessionId, sourceMessageId, memberships, sessionTitle } = batch
  const [session, message] = await Promise.all([
    ctx.db.get(sessionId),
    ctx.db.get(sourceMessageId),
  ])
  if (!session || message?.sessionId !== sessionId) return 0

  let delivered = 0
  for (const membershipId of memberships) {
    const member = await ctx.db.get(membershipId)
    if (member?.sessionId !== sessionId) continue
    await insertUnreadNotification(ctx, {
      sessionId,
      sourceMessageId,
      sessionTitle,
      recipientId: member.userId,
      kind: 'user_message',
      actorName: batch.actorName,
      actorAvatarId: batch.actorAvatarId,
      preview: batch.preview,
    })
    delivered++
  }
  return delivered
}

const batchArgs = { batchId: v.id('notificationBatches') }

export const _deliver = batchMutation({
  args: batchArgs,
  handler: (ctx, { batchId }) => deliverBatch(ctx, batchId),
})

// The following mutations let the correctness probe control worker ordering.
export const _stage = batchMutation({
  args: { sourceMessageId: v.id('messages'), departed: v.id('users') },
  handler: async ({ db }, { sourceMessageId, departed }) => {
    const message = await db.get(sourceMessageId)
    if (message?.sender.type !== 'user') throw new Error('Missing user message')
    const { sessionId } = message
    const members = await db
      .query('userSessions')
      .withIndex('by_sessionId', (q) => q.eq('sessionId', sessionId))
      .collect()
    const batchId = await stage(db, {
      sessionId,
      members,
      sourceMessageId,
      senderId: message.sender.id,
      actorName: 'Fixture',
      preview: 'Pending notification',
    })
    // Even a rejoin before delivery must not receive the previous batch.
    const membership = members.find(({ userId }) => userId === departed)
    if (!batchId || !membership) throw new Error('Missing test batch or member')
    const { _id, _creationTime, ...rejoined } = membership
    await db.delete(_id)
    await db.insert('userSessions', rejoined)
    return batchId
  },
})

export const _failDelivery = batchMutation({
  args: batchArgs,
  handler: async (ctx, { batchId }) => {
    const delivered = await deliverBatch(ctx, batchId)
    throw new Error(`Injected delivery failure after ${delivered} deliveries`)
  },
})
