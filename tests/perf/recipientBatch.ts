import type { Doc, Id } from '@cv/convex/_generated/dataModel'
import type { MutationCtx } from '@cv/convex/_generated/server'
import { notificationPreview } from '@cv/convex/model/notifications'
import {
  type DocumentByName,
  type GenericMutationCtx,
  type MutationBuilder,
  internalMutationGeneric,
  makeFunctionReference,
} from 'convex/server'
import { type Infer, v } from 'convex/values'

import type { RecipientBatchModel } from './recipientBatchSchema'
import { insertOrdinaryBatch } from './recipientRetention'

type QueueCtx = GenericMutationCtx<RecipientBatchModel>
type Pending = DocumentByName<RecipientBatchModel, 'pendingNotifications'>
type Drain = DocumentByName<RecipientBatchModel, 'notificationDrains'>
const mutation: MutationBuilder<RecipientBatchModel, 'internal'> =
  internalMutationGeneric

const chunkSize = 16
const inlineLimit = 256
const leaseMs = 2_000
const drainArgs = v.object({
  recipientId: v.id('users'),
  generation: v.string(),
})
const drainJob = makeFunctionReference<'mutation', Infer<typeof drainArgs>>(
  'recipientBatch:_drain',
)

type UserMessage = {
  sessionId: Id<'sessions'>
  sourceMessageId: Id<'messages'>
  senderId: Id<'users'>
  members: Doc<'userSessions'>[]
  actorName: string
  actorAvatarId?: Id<'avatars'>
  preview: string
}

function recipientDrain(ctx: QueueCtx, recipientId: Id<'users'>) {
  return ctx.db
    .query('notificationDrains')
    .withIndex('by_recipientId', (q) => q.eq('recipientId', recipientId))
    .unique()
}

function pendingFor(ctx: QueueCtx, recipientId: Id<'users'>) {
  return ctx.db
    .query('pendingNotifications')
    .withIndex('by_recipientId', (q) => q.eq('recipientId', recipientId))
}

async function schedule(
  ctx: QueueCtx,
  recipientId: Id<'users'>,
  current?: Drain,
) {
  const generation = crypto.randomUUID()
  const jobId = await ctx.scheduler.runAfter(0, drainJob, {
    recipientId,
    generation,
  })
  const fields = { generation, jobId, expiresAt: Date.now() + leaseMs }
  if (current) await ctx.db.patch(current._id, fields)
  else await ctx.db.insert('notificationDrains', { recipientId, ...fields })
}

/** Append in the send transaction. The active marker is read-only for producers. */
export async function enqueueUserNotification(
  app: MutationCtx,
  { senderId, members, preview, ...event }: UserMessage,
) {
  const ctx = app as QueueCtx
  const recipients = members.filter(({ userId }) => userId !== senderId)
  if (!recipients.length) return
  const session = await ctx.db.get(event.sessionId)
  if (!session) return
  for (const { _id: membershipId, userId: recipientId } of recipients) {
    const id = await ctx.db.insert('pendingNotifications', {
      ...event,
      recipientId,
      membershipId,
      sessionTitle: session.title || session.firstMessagePreview || 'New chat',
      preview: notificationPreview(preview, 'Sent a message'),
    })
    if (!(await recipientDrain(ctx, recipientId)))
      await schedule(ctx, recipientId)
    console.log(
      'notificationQueue ' + JSON.stringify({ recipientId, added: [id] }),
    )
  }
}

async function eligible(ctx: QueueCtx, row: Pending) {
  const [member, message] = await Promise.all([
    ctx.db.get(row.membershipId),
    ctx.db.get(row.sourceMessageId),
  ])
  // Membership deletion fences both departed members and deleted sessions.
  return (
    member?.userId === row.recipientId &&
    member.sessionId === row.sessionId &&
    message?.sessionId === row.sessionId &&
    Boolean(await ctx.db.get(row.sessionId))
  )
}

async function consume(
  ctx: QueueCtx,
  recipientId: Id<'users'>,
  rows: Pending[],
) {
  if (!rows.length) return 0
  const accepted = await Promise.all(rows.map((row) => eligible(ctx, row)))
  const deliveries = rows
    .filter((_, index) => accepted[index])
    .map((row) => ({
      sessionId: row.sessionId,
      sourceMessageId: row.sourceMessageId,
      sessionTitle: row.sessionTitle,
      actorName: row.actorName,
      actorAvatarId: row.actorAvatarId,
      preview: row.preview,
    }))
  await insertOrdinaryBatch(ctx, recipientId, deliveries)
  for (const row of rows) await ctx.db.delete(row._id)
  console.log(
    'notificationQueue ' +
      JSON.stringify({
        recipientId,
        removed: rows.map(({ _id }) => _id),
        delivered: deliveries.length,
        oldestAgeMs: Math.max(0, Date.now() - rows[0]._creationTime),
      }),
  )
  return deliveries.length
}

/** Bring pending notifications into the transaction before a synchronous inbox action. */
export async function flushPendingNotifications(
  app: MutationCtx,
  recipientId: Id<'users'>,
) {
  const ctx = app as QueueCtx
  const rows = await pendingFor(ctx, recipientId).take(inlineLimit + 1)
  if (!rows.length) return
  if (rows.length > inlineLimit)
    throw new Error('Pending notification action exceeded experiment limit')
  await consume(ctx, recipientId, rows)
  const current = await recipientDrain(ctx, recipientId)
  if (current) await ctx.db.delete(current._id)
}

async function drain(
  ctx: QueueCtx,
  { recipientId, generation }: Infer<typeof drainArgs>,
) {
  const current = await recipientDrain(ctx, recipientId)
  if (current?.generation !== generation) return 0
  const rows = await pendingFor(ctx, recipientId).take(chunkSize + 1)
  const delivered = await consume(ctx, recipientId, rows.slice(0, chunkSize))
  if (rows.length > chunkSize) await schedule(ctx, recipientId, current)
  else await ctx.db.delete(current._id)
  return delivered
}

export const _drain = mutation({ args: drainArgs, handler: drain })

export const _recover = mutation({
  args: {},
  handler: async (ctx) => {
    const overdue = await ctx.db
      .query('notificationDrains')
      .withIndex('by_expiresAt', (q) => q.lte('expiresAt', Date.now()))
      .take(32)
    for (const current of overdue)
      await schedule(ctx, current.recipientId, current)
    return overdue.length
  },
})

// Probe controls deliberately hold a queue or schedule a failing worker.
export const _hold = mutation({
  args: { recipientId: v.id('users') },
  handler: async (ctx, { recipientId }) => {
    if (await recipientDrain(ctx, recipientId))
      throw new Error('Queue already active')
    const generation = crypto.randomUUID()
    await ctx.db.insert('notificationDrains', {
      recipientId,
      generation,
      expiresAt: Date.now() + 120_000,
    })
    return generation
  },
})

export const _failDelivery = mutation({
  args: drainArgs,
  handler: async (ctx, args) => {
    const current = await recipientDrain(ctx, args.recipientId)
    if (current?.generation !== args.generation) return 0
    const rows = await pendingFor(ctx, args.recipientId).take(1)
    const delivered = await consume(ctx, args.recipientId, rows)
    throw new Error(`Injected worker failure after ${delivered} deliveries`)
  },
})

const failingJob = makeFunctionReference<'mutation', Infer<typeof drainArgs>>(
  'recipientBatch:_failDelivery',
)

export const _scheduleFailure = mutation({
  args: drainArgs,
  handler: async (ctx, args) => {
    const current = await recipientDrain(ctx, args.recipientId)
    if (current?.generation !== args.generation)
      throw new Error('Missing held queue')
    const jobId = await ctx.scheduler.runAfter(0, failingJob, args)
    await ctx.db.patch(current._id, { jobId, expiresAt: Date.now() + leaseMs })
    return jobId
  },
})

export const _queueState = mutation({
  args: {
    recipientId: v.id('users'),
    jobId: v.optional(v.id('_scheduled_functions')),
  },
  handler: async (ctx, { recipientId, jobId }) => ({
    marker: await recipientDrain(ctx, recipientId),
    pending: (await pendingFor(ctx, recipientId).take(inlineLimit + 1)).length,
    jobState: jobId ? (await ctx.db.system.get(jobId))?.state.kind : undefined,
  }),
})
