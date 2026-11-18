import { api } from '@cv/convex/_generated/api'
import type { Id } from '@cv/convex/_generated/dataModel'
import { expect } from '@playwright/test'
import { strict as assert } from 'node:assert'

import { fixtureClient } from './clients'
import type { Deployment } from './deployment'
import type * as Batch from './recipientBatch'
import { type createMembers, send } from './recipientBatchLoad'
import type * as Fixture from './sharedSendsFixture'

type Member = Awaited<ReturnType<typeof createMembers>>[number]
type Probe = ReturnType<typeof createProbe>

function createProbe(
  deployment: Deployment,
  [sender, recipient, other]: Member[],
) {
  const fixture = fixtureClient<typeof Fixture>(
    deployment,
    'sharedSendsFixture',
  )
  const queue = () => fixtureClient<typeof Batch>(deployment, 'recipientBatch')
  const { userId: recipientId } = recipient
  const session = (target = recipient) =>
    fixture('_session', { userIds: [sender.userId, target.userId] })
  const inspect = () => fixture('_inspectInbox', { recipientId })
  const state = () => queue()('_queueState', { recipientId })
  const hold = () => queue()('_hold', { recipientId })
  const drain = (generation: string) =>
    queue()('_drain', { recipientId, generation })
  const post = (
    sessionId: Id<'sessions'>,
    preview = 'Pending notification probe',
  ) => send(sender.client, sessionId, preview)
  async function reset(sessionId: Id<'sessions'>, ordinary = 0) {
    await fixture('_inbox', {
      recipientId,
      sessionId,
      ordinary,
      protectedCount: 1,
      resetCount: true,
    })
    await recipient.client.mutation(api.notifications.clearRead, {})
  }
  return {
    fixture,
    queue,
    sender,
    recipient,
    other,
    recipientId,
    session,
    inspect,
    state,
    hold,
    drain,
    post,
    reset,
  }
}

const actions = ['markAllRead', 'markSessionRead', 'discardSession'] as const

async function readRace(
  probe: Probe,
  batched: boolean,
  action: (typeof actions)[number],
  race = false,
) {
  const chat = await probe.session()
  const otherChat = await probe.session()
  await probe.reset(otherChat, 16)
  const generation = batched ? await probe.hold() : undefined
  const before = await probe.post(chat)
  const unrelated = await probe.post(otherChat)
  if (batched) assert.equal((await probe.state()).pending, 2)
  const change =
    action === 'markAllRead'
      ? probe.recipient.client.mutation(api.notifications.markAllRead, {})
      : probe.recipient.client.mutation(api.notifications[action], {
          sessionId: chat,
        })
  await Promise.all([
    change,
    race && generation ? probe.drain(generation) : undefined,
  ])

  const after = await probe.post(chat)
  if (generation) assert.equal(await probe.drain(generation), 0)
  await expect
    .poll(async () =>
      (await probe.inspect()).rows.some(
        ({ sourceMessageId }) => sourceMessageId === after,
      ),
    )
    .toBe(true)
  const { rows, count } = await probe.inspect()
  function status(id: Id<'messages'>) {
    const match = rows.filter(({ sourceMessageId }) => sourceMessageId === id)
    assert.ok(match.length <= 1, 'Duplicate notification during inbox action')
    return match[0]?.status ?? 'absent'
  }
  assert.equal(status(before), action === 'discardSession' ? 'absent' : 'read')
  assert.equal(status(unrelated), action === 'markAllRead' ? 'read' : 'unread')
  assert.equal(status(after), 'unread')
  assert.equal(rows.filter(({ attention }) => attention).length, 1)
  assert.equal(
    count,
    rows.filter(({ status, attention }) => status === 'unread' && !attention)
      .length,
  )
  return [status(before), status(unrelated), status(after)]
}

async function verifySourcesAndOrdering(probe: Probe) {
  const chat = await probe.session()
  const removedChat = await probe.session()
  const leftChat = await probe.session()
  await probe.reset(chat, 99)
  const original = await probe.hold()
  const earlier = await probe.post(chat, 'Before ordinary agent event')
  const deleted = await probe.post(chat, 'Deleted message')
  const deletedSession = await probe.post(removedChat, 'Deleted session')
  const departed = await probe.post(leftChat, 'Old membership')
  await probe.fixture('_protectedActivity', {
    sessionId: chat,
    recipientId: probe.recipientId,
  })
  assert.equal(
    (await probe.state()).pending,
    4,
    'Protected approval advanced ordinary queue',
  )
  await probe.fixture('_removeSources', {
    messageId: deleted,
    sessionId: removedChat,
  })
  await probe.fixture('_rejoin', {
    recipientId: probe.recipientId,
    sessionId: leftChat,
  })
  await probe.fixture('_agentActivity', {
    sessionId: chat,
    ownerId: probe.sender.userId,
  })
  assert.equal(await probe.drain(original), 0)

  const generation = await probe.hold()
  const later = await probe.post(chat, 'After ordinary agent event')
  const [drained] = await Promise.all([
    Promise.all([probe.drain(generation), probe.drain(generation)]),
    probe.post(chat, 'Concurrent shutdown send'),
  ])
  assert.equal(drained.filter(Boolean).length, 1)
  const final = await probe.post(chat, 'After worker shutdown')
  await expect
    .poll(async () =>
      (await probe.inspect()).rows.some(
        ({ sourceMessageId }) => sourceMessageId === final,
      ),
    )
    .toBe(true)
  const { rows, count } = await probe.inspect()
  const tail = rows.filter(
    ({ preview, sourceMessageId }) =>
      preview === 'Agent queue probe' || sourceMessageId,
  )
  assert.deepEqual(
    tail.map(({ preview }) => preview),
    [
      'Before ordinary agent event',
      'Agent queue probe',
      'After ordinary agent event',
      'Concurrent shutdown send',
      'After worker shutdown',
    ],
  )
  assert.deepEqual(
    tail.filter(
      ({ sourceMessageId }) =>
        sourceMessageId === earlier || sourceMessageId === later,
    ).length,
    2,
  )
  for (const id of [deleted, deletedSession, departed])
    assert.ok(!rows.some(({ sourceMessageId }) => sourceMessageId === id))
  assert.equal(count, 100)
  assert.equal(rows.filter(({ attention }) => attention).length, 2)
  assert.ok(
    rows.some(
      ({ kind, preview, attention }) =>
        kind === 'approval_required' &&
        preview === 'Protected queue probe' &&
        attention,
    ),
  )
  assert.equal(rows.filter(({ attention }) => !attention).length, 100)
}

async function verifyRecovery(probe: Probe) {
  const chat = await probe.session()
  const independent = await probe.session(probe.other)
  await probe.reset(chat)
  const generation = await probe.hold()
  const ids: Id<'messages'>[] = []
  for (let index = 0; index < 18; index++)
    ids.push(await probe.post(chat, `Recovery ${index}`))
  const other = await probe.post(independent)
  await expect
    .poll(async () => {
      const rows = await probe.other.client.query(api.notifications.list, {
        status: 'unread',
      })
      return rows.some(({ sourceMessageId }) => sourceMessageId === other)
    })
    .toBe(true)
  assert.equal((await probe.state()).pending, 18)
  const jobId = await probe.queue()('_scheduleFailure', {
    recipientId: probe.recipientId,
    generation,
  })
  await expect
    .poll(
      async () =>
        (
          await probe.queue()('_queueState', {
            recipientId: probe.recipientId,
            jobId,
          })
        ).jobState,
      {
        intervals: [30, 60, 150],
      },
    )
    .toBe('failed')
  assert.equal((await probe.state()).pending, 18)
  assert.equal(
    (await probe.inspect()).rows.some(
      ({ sourceMessageId }) => sourceMessageId && ids.includes(sourceMessageId),
    ),
    false,
  )
  await expect
    .poll(async () => (await probe.state()).pending, { timeout: 10_000 })
    .toBe(0)
  const { rows, count } = await probe.inspect()
  assert.deepEqual(
    rows
      .filter(
        ({ sourceMessageId }) =>
          sourceMessageId && ids.includes(sourceMessageId),
      )
      .map(({ sourceMessageId }) => sourceMessageId),
    ids,
  )
  assert.equal(count, 18)
  assert.equal((await probe.state()).marker, null)
  assert.equal(await probe.drain(generation), 0)
}

export async function verifyRecipientBatches(
  deployment: Deployment,
  members: Member[],
  batched: boolean,
) {
  const probe = createProbe(deployment, members)
  const results: Record<string, unknown> = {}
  for (const action of actions)
    results[action] = await readRace(probe, batched, action)
  if (batched) {
    for (const action of actions)
      assert.deepEqual(
        await readRace(probe, true, action, true),
        results[action],
      )
    await verifySourcesAndOrdering(probe)
    await verifyRecovery(probe)
    Object.assign(results, {
      invalidSourcesAndOrdering: true,
      duplicateAndShutdown: true,
      simultaneousReadAndDrain: true,
      protectedApproval: true,
      schedulerRecovery: true,
    })
  }
  return results
}
