import { api } from '@cv/convex/_generated/api'
import type { Id } from '@cv/convex/_generated/dataModel'
import type { ConvexHttpClient } from 'convex/browser'
import { strict as assert } from 'node:assert'
import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { type Account, deadline, fixtureClient, observeInbox } from './clients'
import type { Deployment } from './deployment'
import type * as Batch from './notificationBatch'
import type * as Fixture from './sharedSendsFixture'

export type Member = Account & { client: ConvexHttpClient }

export async function edit(
  path: string,
  original: string,
  replacement: string,
) {
  const source = await readFile(path, 'utf8')
  assert.equal(source.split(original).length, 2, `Cannot patch ${path}`)
  await writeFile(path, source.replace(original, replacement))
}

/** Install the experimental queue and producer only in the disposable copy. */
export async function installNotificationBatches(functions: string) {
  await Promise.all(
    ['notificationBatch.ts', 'notificationBatchSchema.ts'].map((file) =>
      copyFile(join(import.meta.dir, file), join(functions, file)),
    ),
  )
  await edit(
    join(functions, 'schema.ts'),
    'export default defineSchema({',
    'export default defineSchema({\n  notificationBatches,',
  )
  await edit(
    join(functions, 'schema.ts'),
    'const schemaValidation = true',
    "import { notificationBatches } from './notificationBatchSchema'\n\nconst schemaValidation = true",
  )
  const send = join(functions, 'model/chat/send.ts')
  await edit(
    send,
    "import { notifyUserMessage } from '../notifications/records'",
    "import { enqueueUserNotification } from '../../notificationBatch'",
  )
  await edit(
    send,
    'await notifyUserMessage(ctx, {',
    'await enqueueUserNotification(ctx, {',
  )
}

type DeliveryProbe = {
  sessionId: Id<'sessions'>
  sourceMessageId: Id<'messages'>
  departed: Id<'users'>
  recipientClients: ConvexHttpClient[]
}

export async function verifyScheduledDelivery(
  deployment: Deployment,
  [sender, recipient, departed]: Member[],
) {
  const members = [sender, recipient, departed]
  const mutate = fixtureClient<typeof Fixture>(deployment, 'sharedSendsFixture')
  const sessionId = await mutate('_session', {
    userIds: members.map(({ userId }) => userId),
  })
  const recipientClients = [recipient.client, departed.client]
  await Promise.all(
    members.map(async (member) => {
      member.client.setAuth(await member.refreshToken())
    }),
  )
  const observers = [recipient, departed].map((member) =>
    observeInbox(deployment, member),
  )
  try {
    await deadline(
      Promise.all(observers.map(({ ready }) => ready)),
      'replay probe subscriptions',
    )
    const sourceMessageId = await sender.client.mutation(api.chat.sendMessage, {
      sessionId,
      content: 'Performance replay probe',
      silent: true,
    })
    await Promise.all(
      observers.map((observer) => observer.delivery([sourceMessageId])),
    )
    await Promise.all(
      recipientClients.map((client) =>
        client.mutation(api.notifications.discardSession, { sessionId }),
      ),
    )
    await verifyBatchReplay(deployment, {
      sessionId,
      sourceMessageId,
      departed: departed.userId,
      recipientClients,
    })
  } finally {
    await Promise.all(observers.map(({ close }) => close()))
  }
}

/** Verify rollback and replay using the same delivery code as the worker. */
async function verifyBatchReplay(deployment: Deployment, probe: DeliveryProbe) {
  const mutate = () =>
    fixtureClient<typeof Batch>(deployment, 'notificationBatch')
  const batchId = await mutate()('_stage', {
    sourceMessageId: probe.sourceMessageId,
    departed: probe.departed,
  })
  await assert.rejects(
    mutate()('_failDelivery', { batchId }),
    /Injected delivery failure after 1 deliveries/,
  )
  await verifyInbox(probe, [0, 0])
  const deliveries = await Promise.all([
    mutate()('_deliver', { batchId }),
    mutate()('_deliver', { batchId }),
  ])
  assert.deepEqual(deliveries.sort(), [0, 1], 'Batch replay was not idempotent')
  await verifyInbox(probe, [1, 0])
}

async function verifyInbox(probe: DeliveryProbe, expected: number[]) {
  const counts = await Promise.all(
    probe.recipientClients.map(async (client) => {
      const rows = await client.query(api.notifications.list, {
        status: 'unread',
      })
      return rows.filter(
        ({ sessionId, sourceMessageId }) =>
          sessionId === probe.sessionId &&
          sourceMessageId === probe.sourceMessageId,
      ).length
    }),
  )
  assert.deepEqual(counts, expected)
}
