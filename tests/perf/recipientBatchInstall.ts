import { copyFile } from 'node:fs/promises'
import { join } from 'node:path'

import { edit, installNotificationBatches } from './notificationBatchExperiment'

export async function installRecipientBatches(functions: string) {
  await Promise.all(
    [
      'recipientBatch.ts',
      'recipientBatchSchema.ts',
      'recipientRetention.ts',
    ].map((file) =>
      copyFile(join(import.meta.dir, file), join(functions, file)),
    ),
  )
  const schema = join(functions, 'schema.ts')
  await edit(
    schema,
    'const schemaValidation = true',
    "import { pendingNotifications, notificationDrains } from './recipientBatchSchema'\n\nconst schemaValidation = true",
  )
  await edit(
    schema,
    'export default defineSchema({',
    'export default defineSchema({\n  pendingNotifications,\n  notificationDrains,',
  )
  const send = join(functions, 'model/chat/send.ts')
  await edit(
    send,
    "import { notifyUserMessage } from '../notifications/records'",
    "import { enqueueUserNotification } from '../../recipientBatch'",
  )
  await edit(
    send,
    "if (sender.type === 'user') {\n    await notifyUserMessage(ctx, {",
    "if (sender.type === 'user') {\n    await enqueueUserNotification(ctx, {",
  )
  await installInboxFences(functions)
  const cron = join(functions, 'crons.ts')
  await edit(
    cron,
    "import { cronJobs } from 'convex/server'",
    "import { cronJobs, makeFunctionReference } from 'convex/server'",
  )
  await edit(
    cron,
    'export default crons',
    `crons.interval(
    'recover pending notification drains',
    { seconds: 1 },
    makeFunctionReference<'mutation', Record<string, never>>('recipientBatch:_recover'),
  )
  export default crons`,
  )
}

async function installInboxFences(functions: string) {
  const importFlush =
    "import { flushPendingNotifications } from '../../recipientBatch'\n"
  const model = join(functions, 'model/notifications/records.ts')
  await edit(
    model,
    'type NotificationEvent = {',
    `${importFlush}\ntype NotificationEvent = {`,
  )
  await edit(
    model,
    'export async function markAllRead(ctx: AuthMutationCtx) {',
    'export async function markAllRead(ctx: AuthMutationCtx) {\n  await flushPendingNotifications(ctx, ctx.userId)',
  )
  for (const name of ['markSessionRead', 'discardSession']) {
    const signature = `export async function ${name}(
  ctx: AuthMutationCtx,
  { sessionId }: { sessionId: Id<'sessions'> },
) {`
    await edit(
      model,
      signature,
      `${signature}\n  await flushPendingNotifications(ctx, ctx.userId)`,
    )
  }
  const retention = join(functions, 'model/notifications/retention.ts')
  await edit(
    retention,
    'export function statusLimit',
    `${importFlush}\nexport function statusLimit`,
  )
  const insert =
    "  await ctx.db.insert('notifications', { ...notification, status: 'unread' })"
  await edit(
    retention,
    insert,
    `  if (!notification.attention) await flushPendingNotifications(ctx, notification.recipientId)\n${insert}`,
  )
}

/** Add comparable queue instrumentation to the original per-message variant. */
export async function installMeasuredMessageBatches(functions: string) {
  await installNotificationBatches(functions)
  const file = join(functions, 'notificationBatch.ts')
  const schedule =
    '  if (batchId) await ctx.scheduler.runAfter(0, deliver, { batchId })'
  await edit(
    file,
    schedule,
    `  if (batchId) {
    await ctx.scheduler.runAfter(0, deliver, { batchId })
    const added = args.members.filter((member) => member.userId !== args.senderId)
    for (const { userId: recipientId, _id } of added) {
      console.log('notificationQueue ' + JSON.stringify({ recipientId, added: [batchId + ':' + _id] }))
    }
  }`,
  )
  await edit(
    file,
    '  await ctx.db.delete(batchId)',
    `  await ctx.db.delete(batchId)
  for (const membershipId of batch.memberships) {
    console.log('notificationQueue ' + JSON.stringify({
      removed: [batchId + ':' + membershipId],
      oldestAgeMs: Math.max(0, Date.now() - batch._creationTime),
    }))
  }`,
  )
}
