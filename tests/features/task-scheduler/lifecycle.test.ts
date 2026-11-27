import type { Id } from '@cv/convex/_generated/dataModel'
import { discardSession } from '@cv/convex/model/notifications/records'
import { expireStream } from '@cv/convex/model/stream/expiry'
import { requestImmediateStop } from '@cv/convex/model/stream/stop'
import { get, setState } from '@cv/convex/model/tasks/definitions'
import { dispatch } from '@cv/convex/model/tasks/dispatch'
import { settleRun } from '@cv/convex/model/tasks/outcomes'
import { expect, test } from 'bun:test'
import { lifecycleDatabase } from '~/tests/helpers/lifecycle-db'

const day = 86400000
const today = Math.floor(Date.now() / day) * day
const due = today - 4 * day
const taskId = 'task' as Id<'scheduledTasks'>
const task = {
  _id: taskId,
  ownerId: 'owner',
  agentId: 'agent',
  agentName: 'Mailbox',
  prompt: '$ count my emails',
  state: 'active',
  revision: 2,
  nextRunAt: due,
  schedule: {
    startDate: '2020-01-01',
    time: '00:00',
    zone: 'UTC',
    repeat: { kind: 'daily', every: 1 },
  },
}
function fixture(runMutation = async () => {}) {
  const db = lifecycleDatabase({
    scheduledTasks: [{ ...task }],
    users: [{ _id: 'owner', role: 'user', subject: 'owner' }],
    agents: [{ _id: 'agent', ownerId: 'owner', name: 'Mailbox' }],
  })
  const ctx = Object.assign(db.ctx, { runMutation, userId: 'owner' })
  return { ...db, ctx }
}

test('a wake-up claims the latest occurrence once, creates a hidden session, and serializes a waiting occurrence', async () => {
  const { ctx, rows, scheduled } = fixture()
  await dispatch(ctx, { taskId, due, revision: 1 })
  expect(rows('scheduledTaskRuns')).toHaveLength(0)
  await dispatch(ctx, { taskId, due, revision: 2 })
  await dispatch(ctx, { taskId, due, revision: 2 })
  const [run] = rows('scheduledTaskRuns')
  expect(rows('scheduledTaskRuns')).toHaveLength(1)
  expect(run).toMatchObject({
    scheduledFor: today,
    skippedFrom: due,
    status: 'running',
    prompt: task.prompt,
  })
  expect(rows('userSessions')[0]).toMatchObject({
    hidden: true,
    role: 'owner',
    sessionId: run.sessionId,
  })
  expect(rows('sessionAgents')[0].agentId).toBe('agent')
  const runId = run._id as Id<'scheduledTaskRuns'>
  await settleRun(ctx, runId, 'succeeded', 'Eight emails')
  await settleRun(ctx, runId, 'failed', 'stale callback')
  expect(rows('notifications')).toHaveLength(1)
  expect(rows('notifications')[0]).toMatchObject({
    recipientId: 'owner',
    kind: 'task_succeeded',
    sessionId: run.sessionId,
  })
  expect(scheduled.at(-1)?.at).toBe(today + day)
  await discardSession(ctx, { sessionId: run.sessionId as Id<'sessions'> })
  expect(rows('notifications')).toHaveLength(1)
})

test('a one-time task finishes only after its agent turn ends', async () => {
  const { ctx, rows, scheduled } = fixture()
  const [definition] = rows('scheduledTasks')
  definition.schedule = {
    ...task.schedule,
    startDate: new Date(due).toISOString().slice(0, 10),
    repeat: { kind: 'once' },
  }
  await dispatch(ctx, { taskId, due, revision: 2 })
  const [run] = rows('scheduledTaskRuns')
  expect(run.status).toBe('running')
  expect(definition.state).toBe('active')
  expect(definition.nextRunAt).toBeUndefined()
  await settleRun(ctx, run._id as Id<'scheduledTaskRuns'>, 'succeeded', 'Done')
  expect(definition.state).toBe('finished')
  expect(scheduled.some((job) => job.args.taskId === taskId)).toBe(false)
})

test('launch failure finalizes the run and preserves the link to the session', async () => {
  const { ctx, rows } = fixture(async () => {
    throw new Error('Agent unavailable')
  })
  await dispatch(ctx, { taskId, due, revision: 2 })
  expect(rows('scheduledTaskRuns')[0]).toMatchObject({
    status: 'failed',
    detail: 'Agent unavailable',
  })
  expect(rows('notifications')[0]).toMatchObject({
    kind: 'task_failed',
    sessionId: rows('sessions')[0]._id,
  })
})

test('early stop before the first token clears the active slot, respecting a pause made during the run', async () => {
  const { ctx, rows, scheduled } = fixture()
  await dispatch(ctx, { taskId, due, revision: 2 })
  const [run] = rows('scheduledTaskRuns')
  await setState(ctx, { taskId, state: 'paused' })
  const stream = {
    _id: 'stream',
    sessionId: run.sessionId,
    taskRunId: run._id,
    state: { phase: 'reserved' },
    command: { kind: 'invoke' },
  }
  rows('streams').push(stream)
  await requestImmediateStop(ctx, stream as never)
  expect(run.status).toBe('failed')
  expect(rows('scheduledTasks')[0]).toMatchObject({
    state: 'paused',
    activeRunId: undefined,
    nextRunAt: undefined,
  })
  expect(scheduled.some((job) => job.args.taskId === taskId)).toBe(false)
})

test('other owners cannot read or alter a task', async () => {
  const { ctx } = fixture()
  Object.assign(ctx, { userId: 'other' })
  expect(await get(ctx, { taskId })).toBeNull()
  await expect(setState(ctx, { taskId, state: 'archived' })).rejects.toThrow(
    'Task not found',
  )
})

test('lease expiry fails an unfinished run and does not replay the interrupted turn', async () => {
  const { ctx, rows } = fixture()
  await dispatch(ctx, { taskId, revision: 2, due })
  const [run] = rows('scheduledTaskRuns')
  const stream = {
    _id: 'stream',
    sessionId: run.sessionId,
    taskRunId: run._id,
    command: { kind: 'invoke' },
    state: { phase: 'reserved' },
    agentId: 'agent',
  }
  rows('streams').push(stream)
  await expireStream(ctx, stream as never)
  expect(run.status).toBe('failed')
  expect(rows('notifications')).toHaveLength(1)
  expect(rows('streams')).toHaveLength(0)
  await settleRun(
    ctx,
    run._id as Id<'scheduledTaskRuns'>,
    'succeeded',
    'Late completion',
  )
  expect(run.status).toBe('failed')
})

test('a repeated calendar occurrence found in history is skipped even after the schedule is rearmed', async () => {
  const { ctx, rows, scheduled } = fixture()
  rows('scheduledTaskRuns').push({
    _id: 'prior',
    taskId,
    scheduledFor: today,
    status: 'succeeded',
  })
  await dispatch(ctx, { taskId, due, revision: 2 })
  expect(rows('scheduledTaskRuns')).toHaveLength(1)
  expect(rows('sessions')).toHaveLength(0)
  expect(scheduled.at(-1)?.at).toBe(today + day)
})
