import type { Id } from '@cv/convex/_generated/dataModel'
import { sendMessage } from '@cv/convex/model/chat/send'
import { remove } from '@cv/convex/model/session/sessionTeardown'
import { _claim } from '@cv/convex/model/stream/lifecycleClaims'
import { _complete } from '@cv/convex/model/stream/lifecycleTerminal'
import { runDestination } from '@cv/convex/model/tasks/definitions'
import { expect, test } from 'bun:test'
import { skillsDatabase } from '~/tests/helpers/skills-db'

const taskId = 'task' as Id<'scheduledTasks'>
const promptId = 'prompt' as Id<'messages'>
const sessionId = 'session' as Id<'sessions'>
const streamId = 'stream' as Id<'streams'>
const execution = { streamId, generation: 1 }

function pendingRun() {
  const fixture = skillsDatabase()
  const { rows } = fixture
  Object.assign(fixture.ctx.scheduler, { cancel: async () => {} })
  let clock = 20
  const insert = fixture.db.insert
  fixture.db.insert = (table, fields) =>
    insert(table, { _creationTime: clock++, ...fields })
  rows('scheduledTasks').push({
    _id: taskId,
    ownerId: 'owner',
    activeRunId: 'run',
    state: 'active',
  })
  rows('scheduledTaskRuns').push({
    _id: 'run',
    taskId,
    sessionId,
    status: 'running',
    title: 'Check mail',
    agentName: 'Mailbox',
  })
  rows('sessions').push({
    _id: sessionId,
    taskRunId: 'run',
    activeAgentId: 'agent',
    ownerId: 'owner',
  })
  rows('userSessions').push({
    _id: 'member',
    sessionId,
    userId: 'owner',
    role: 'owner',
  })
  rows('sessionAgents').push({ _id: 'link', sessionId, agentId: 'agent' })
  rows('agents').push({ _id: 'agent', name: 'Mailbox', ownerId: 'owner' })
  rows('messages').push(userMessage(promptId, 10))
  rows('streams').push({
    _id: streamId,
    _creationTime: 11,
    sessionId,
    agentId: 'agent',
    invokedBy: 'owner',
    taskRunId: 'run',
    generation: 1,
    leaseExpiresAt: Date.now() + 60_000,
    command: { kind: 'invoke' },
    state: { phase: 'pending' },
    contextBoundaryMessageId: promptId,
    contextBoundaryCreationTime: 10,
  })
  return fixture
}

function userMessage(id: string, time: number) {
  return {
    _id: id,
    _creationTime: time,
    sessionId,
    sender: { type: 'user', id: 'owner' },
    role: 'user',
    status: 'done',
    contextEligible: true,
  }
}

test('a follow-up before the first claim interrupts the scheduled run and continues the chat', async () => {
  const { ctx, rows } = pendingRun()
  const manual = await sendMessage(ctx, {
    sessionId,
    content: 'A separate request',
  })
  const generation = rows('streams')[0].generation as number
  const current = { streamId, generation }
  const stream = await _claim(ctx, current)
  expect(stream?.contextBoundaryMessageId).toEqual(manual)
  expect(stream?.taskRunId).toBeUndefined()
  await _complete(ctx, current)
  expect(rows('scheduledTaskRuns')[0].status).toBe('failed')
  expect(
    rows('notifications')
      .filter((row) => row.taskRunId)
      .map((row) => row.kind),
  ).toEqual(['task_failed'])
})

test('a persisted mailbox tool error fails the run even without SDK error metadata', async () => {
  const { ctx, rows } = pendingRun()
  await _claim(ctx, execution)
  rows('messageContents')[0].parts = [
    {
      type: 'tool-mailbox',
      toolCallId: 'check',
      state: 'output-error',
      errorText: 'Mailbox unavailable',
    },
    { type: 'text', text: 'Finished checking.' },
  ]
  await _complete(ctx, execution)
  expect(rows('scheduledTaskRuns')[0]).toMatchObject({
    status: 'failed',
    detail: 'Mailbox unavailable',
  })
  expect(rows('notifications')[0]).toMatchObject({
    kind: 'task_failed',
    preview: 'Mailbox unavailable',
  })
})

test('deleting an active session preserves its failure notice and routes the owner to history', async () => {
  const { ctx, rows } = pendingRun()
  expect(await runDestination(ctx, { runId: 'run' })).toEqual({
    taskId,
    sessionId,
  })
  await _claim(ctx, execution)
  await remove(ctx, { sessionId })
  expect(rows('notifications')).toHaveLength(1)
  expect(rows('notifications')[0]).toMatchObject({
    taskRunId: 'run',
    status: 'unread',
    kind: 'task_failed',
  })
  expect(await runDestination(ctx, { runId: 'run' })).toEqual({
    taskId,
    sessionId: undefined,
  })
  expect(
    await runDestination(
      { ...ctx, userId: 'other' as Id<'users'> },
      { runId: 'run' },
    ),
  ).toBeNull()
})
