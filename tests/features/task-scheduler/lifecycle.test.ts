import type { Id } from '@cv/convex/_generated/dataModel'
import type { MutationCtx } from '@cv/convex/_generated/server'
import { discardSession } from '@cv/convex/model/notifications/records'
import { expireStream } from '@cv/convex/model/stream/expiry'
import { requestImmediateStop } from '@cv/convex/model/stream/stop'
import { get, save, setState } from '@cv/convex/model/tasks/definitions'
import { dispatch, runNow } from '@cv/convex/model/tasks/dispatch'
import { settleRun } from '@cv/convex/model/tasks/outcomes'
import {
  type FilesystemCall,
  executionApprovals,
} from '@cv/convex/model/tool/executionApprovals'
import { approvalsForFilesystemCall } from '@cv/convex/model/tool/filesystemApprovals'
import { modelReference } from '@cv/core/model-reference'
import { expect, spyOn, test } from 'bun:test'
import { lifecycleDatabase } from '~/tests/helpers/lifecycle-db'

const day = 86400000
const today = Math.floor(Date.now() / day) * day
const due = today - 4 * day
const taskId = 'task' as Id<'scheduledTasks'>
const modelId = modelReference('owned-provider', 'test-model')
const task = {
  _id: taskId,
  ownerId: 'owner',
  agentId: 'agent',
  agentName: 'Mailbox',
  modelId,
  reasoningEffort: 'high' as const,
  prompt: '$ count my emails',
  state: 'active',
  revision: 2,
  nextRunAt: due,
  schedule: {
    startDate: '2020-01-01',
    time: '00:00',
    zone: 'UTC',
    repeat: { kind: 'daily' as const, every: 1 },
  },
}
function fixture(runMutation = async () => {}) {
  const db = lifecycleDatabase({
    scheduledTasks: [{ ...task }],
    users: [{ _id: 'owner', role: 'user', subject: 'owner' }],
    agents: [{ _id: 'agent', ownerId: 'owner', name: 'Mailbox' }],
    modelProviders: [
      {
        _id: 'owned-provider',
        ownerId: 'owner',
        key: 'openai',
        enabled: true,
        models: [
          { id: 'test-model' },
          { id: 'no-reasoning', reasoning: { type: 'none' } },
        ],
      },
    ],
  })
  const ctx = Object.assign(db.ctx, { runMutation, userId: 'owner' })
  Object.assign((db.ctx as MutationCtx).db, {
    normalizeId: (_table: string, value: string) => value,
  })
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

test('a saved interval skips missed slots and waits for the active run to settle', async () => {
  const minute = 60_000
  const { ctx, rows, scheduled } = fixture()
  const clock = spyOn(Date, 'now').mockReturnValue(today)
  try {
    await save(ctx, {
      taskId,
      definition: {
        agentId: 'agent' as Id<'agents'>,
        modelId,
        reasoningEffort: 'high',
        prompt: task.prompt,
        schedule: {
          startDate: new Date(today).toISOString().slice(0, 10),
          time: '00:00',
          zone: 'UTC',
          repeat: { kind: 'minutes', every: 5 },
        },
      },
    })
    const first = scheduled.at(-1)!
    expect(first.at).toBe(today + 5 * minute)
    clock.mockReturnValue(today + 17 * minute)
    await dispatch(ctx, first.args as Parameters<typeof dispatch>[1])
    const [run] = rows('scheduledTaskRuns')
    expect(run).toMatchObject({
      scheduledFor: today + 15 * minute,
      skippedFrom: first.at,
    })
    expect(scheduled.at(-1)).toBe(first)

    clock.mockReturnValue(today + 26 * minute)
    await settleRun(
      ctx,
      run._id as Id<'scheduledTaskRuns'>,
      'succeeded',
      'Done',
    )
    const next = scheduled.at(-1)!
    expect(next.at).toBe(today + 20 * minute)
    await dispatch(ctx, next.args as Parameters<typeof dispatch>[1])
    expect(rows('scheduledTaskRuns')).toHaveLength(2)
    expect(rows('scheduledTaskRuns')[1].scheduledFor).toBe(today + 25 * minute)
  } finally {
    clock.mockRestore()
  }
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
  await expect(runNow(ctx, { taskId })).rejects.toThrow('Task not found')
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

test('a manual run releases the pending wake-up and leaves the calendar occurrence due', async () => {
  const { ctx, rows, scheduled, cancelled } = fixture()
  const [definition] = rows('scheduledTasks')
  definition.jobId = 'pending'
  const runId = await runNow(ctx, { taskId })
  expect(cancelled).toEqual(['pending'])
  const [run] = rows('scheduledTaskRuns')
  expect(run).toMatchObject({
    _id: runId,
    trigger: 'manual',
    status: 'running',
  })
  expect(run.skippedFrom).toBeUndefined()
  expect(definition.nextRunAt).toBe(due)
  expect(rows('userSessions')[0]).toMatchObject({
    sessionId: run.sessionId,
    hidden: true,
  })
  await expect(runNow(ctx, { taskId })).rejects.toThrow(
    'already has a running session',
  )
  await dispatch(ctx, { taskId, due, revision: 2 })
  expect(rows('scheduledTaskRuns')).toHaveLength(1)
  await settleRun(ctx, runId, 'succeeded', 'Done')
  expect(rows('notifications')[0]).toMatchObject({
    taskRunId: runId,
    kind: 'task_succeeded',
  })
  expect(scheduled.at(-1)?.at).toBe(due)

  // An immediate run at the exact scheduled time must not consume that occurrence.
  run.scheduledFor = today
  await dispatch(ctx, { taskId, due, revision: 2 })
  expect(rows('scheduledTaskRuns')).toHaveLength(2)
  expect(rows('scheduledTaskRuns')[1]).toMatchObject({
    scheduledFor: today,
    skippedFrom: due,
  })
})

test('a paused task can run manually and stays paused after a failed launch', async () => {
  const { ctx, rows, scheduled } = fixture(async () => {
    throw new Error('Agent unavailable')
  })
  await setState(ctx, { taskId, state: 'paused' })
  const runId = await runNow(ctx, { taskId })
  expect(rows('scheduledTaskRuns')[0]).toMatchObject({
    status: 'failed',
    trigger: 'manual',
  })
  expect(rows('notifications')[0]).toMatchObject({
    taskRunId: runId,
    kind: 'task_failed',
  })
  expect(rows('scheduledTasks')[0]).toMatchObject({
    state: 'paused',
    activeRunId: undefined,
  })
  expect(scheduled).toHaveLength(0)
  await setState(ctx, { taskId, state: 'archived' })
  await expect(runNow(ctx, { taskId })).rejects.toThrow('This task is archived')
})

test('task choices bind to the run session independently of recent chat choices', async () => {
  const { ctx, rows } = fixture()
  rows('settings').push({
    _id: 'settings',
    ownerId: 'owner',
    recentModel: 'recent-model',
    recentReasoning: 'low',
  })
  const definition = {
    agentId: 'agent' as Id<'agents'>,
    prompt: task.prompt,
    schedule: task.schedule,
  }

  await expect(save(ctx, { taskId, definition })).rejects.toThrow(
    'Choose a model',
  )
  await expect(
    save(ctx, { taskId, definition: { ...definition, modelId } }),
  ).rejects.toThrow('Choose a supported reasoning effort')
  await expect(
    save(ctx, {
      taskId,
      definition: {
        ...definition,
        modelId: modelReference('other', 'test-model'),
      },
    }),
  ).rejects.toThrow('task model is unavailable')
  await save(ctx, {
    taskId,
    definition: { ...definition, modelId, reasoningEffort: 'high' },
  })
  const runId = await runNow(ctx, { taskId })
  expect(rows('sessions')[0]).toMatchObject({
    model: { id: modelId },
    reasoningEffort: 'high',
  })
  await settleRun(ctx, runId, 'succeeded', 'Done')

  const nonReasoningModel = modelReference('owned-provider', 'no-reasoning')
  await save(ctx, {
    taskId,
    definition: { ...definition, modelId: nonReasoningModel },
  })
  await runNow(ctx, { taskId })
  expect(rows('sessions')[1]).toMatchObject({
    model: { id: nonReasoningModel },
    reasoningEffort: undefined,
  })
})

test('legacy tasks with missing choices report what to select without using recent chat choices', async () => {
  for (const legacyModelId of [undefined, modelId]) {
    const { ctx, rows } = fixture()
    const [definition] = rows('scheduledTasks')
    definition.modelId = legacyModelId
    definition.reasoningEffort = undefined
    rows('settings').push({
      _id: 'settings',
      ownerId: 'owner',
      recentModel: 'recent-model',
      recentReasoning: 'low',
    })

    const runId = await runNow(ctx, { taskId })
    const expectedError = legacyModelId
      ? 'Choose a supported reasoning effort'
      : 'Choose a model'
    expect(rows('scheduledTaskRuns')[0]).toMatchObject({
      _id: runId,
      status: 'failed',
    })
    expect(rows('scheduledTaskRuns')[0].detail).toContain(expectedError)
    expect(rows('sessions')[0]).toMatchObject({
      model: legacyModelId ? { id: legacyModelId } : undefined,
      reasoningEffort: undefined,
    })
    expect(rows('notifications')[0]).toMatchObject({
      taskRunId: runId,
      kind: 'task_failed',
    })
  }
})

test('a fixed agent model and effort satisfy the task choices', async () => {
  const { ctx, rows } = fixture()
  rows('agents')[0].modelOverride = { modelId, reasoningEffort: 'medium' }
  await save(ctx, {
    taskId,
    definition: {
      agentId: 'agent' as Id<'agents'>,
      prompt: task.prompt,
      schedule: task.schedule,
    },
  })
  await runNow(ctx, { taskId })
  expect(rows('scheduledTaskRuns')[0].status).toBe('running')
  expect(rows('sessions')[0].activeAgentId).toBe('agent')
})

const folderId = 'project' as Id<'sessionFolders'>
const reviewedWorkspaceKey = '["project",1,["/project"]]'
const grantDefinition = {
  agentId: 'agent' as Id<'agents'>,
  modelId,
  reasoningEffort: 'high' as const,
  prompt: 'Prepare report',
  schedule: task.schedule,
  folderId,
  approvals: { shell: ['git checkout'], paths: ['reports'] },
}

function policyFixture() {
  const fixtureData = fixture()
  const { ctx, rows } = fixtureData
  Object.assign(ctx, { role: 'admin' })
  rows('users')[0].role = 'admin'
  rows('sessionFolders').push({
    _id: folderId,
    ownerId: 'owner',
    revision: 1,
    name: 'Project',
    sources: [{ id: 'source', path: '/project', label: 'Project' }],
  })
  return fixtureData
}

test('saving task grants validates the workspace, role, paths and reviewed revision', async () => {
  const { ctx, rows } = policyFixture()
  const [folder] = rows('sessionFolders')
  const [definition] = rows('scheduledTasks')
  definition.jobId = 'original-job'
  await expect(
    save(ctx, {
      taskId,
      definition: { ...grantDefinition, folderId: undefined },
    }),
  ).rejects.toThrow('Select a workspace')
  await expect(
    save(ctx, {
      taskId,
      definition: {
        ...grantDefinition,
        folderId: undefined,
        approvals: { shell: [], paths: ['/reports'] },
      },
    }),
  ).resolves.toBe(taskId)
  await expect(
    save(ctx, { taskId, definition: grantDefinition }),
  ).rejects.toThrow('Review the automatic approvals')
  folder.ownerId = 'other'
  await expect(
    save(ctx, {
      taskId,
      definition: grantDefinition,
      reviewedWorkspaceKey,
    }),
  ).rejects.toThrow('Folder not found')
  folder.ownerId = 'owner'
  Object.assign(ctx, { role: 'user' })
  await expect(
    save(ctx, {
      taskId,
      definition: grantDefinition,
      reviewedWorkspaceKey,
    }),
  ).rejects.toThrow('Forbidden')
  Object.assign(ctx, { role: 'admin' })
  await save(ctx, { taskId, definition: grantDefinition, reviewedWorkspaceKey })
  expect(definition).toMatchObject({
    folderId,
    approvalWorkspaceKey: reviewedWorkspaceKey,
    approvalRevision: 2,
    jobId: 'original-job',
    revision: 2,
    nextRunAt: due,
  })
})

test('manual and scheduled runs get only their own grants, for their original stream', async () => {
  const { ctx, rows } = policyFixture()
  rows('agents')[0].autoApprove = { shell: ['git status'] }
  await save(ctx, { taskId, definition: grantDefinition, reviewedWorkspaceKey })
  await dispatch(ctx, { taskId, due, revision: 2 })
  const first = rows('scheduledTaskRuns')[0]
  const otherTask = await save(ctx, {
    definition: {
      ...grantDefinition,
      folderId: undefined,
      approvals: { shell: ['git diff'], paths: [] },
    },
  })
  const manualId = await runNow(ctx, { taskId: otherTask })
  const second = rows('scheduledTaskRuns')[1]
  expect(rows('sessions')[0].folderId).toBe(folderId)
  expect(first.approvalRevision).toBe(1)
  expect(second).toMatchObject({
    _id: manualId,
    approvalRevision: 1,
    trigger: 'manual',
  })

  const stream = {
    _id: 'stream',
    generation: 0,
    sessionId: first.sessionId,
    taskRunId: first._id,
    agentId: 'agent',
    invokedBy: 'owner',
    state: { phase: 'streaming' },
  }
  rows('streams').push(stream)
  const execution = { streamId: 'stream' as Id<'streams'>, generation: 0 }
  const read = () => executionApprovals(ctx, execution)
  expect((await read()).approvals).toMatchObject({
    shell: ['git status', 'git checkout'],
    paths: ['reports'],
  })
  Object.assign(stream, { sessionId: second.sessionId, taskRunId: second._id })
  expect((await read()).approvals?.shell).toEqual(['git status', 'git diff'])
  Object.assign(stream, { sessionId: first.sessionId, taskRunId: undefined })
  expect((await read()).approvals?.shell).toEqual(['git status'])

  // Neither a child nor a copied chat can use the parent run's credentials.
  const session = rows('sessions')[0]
  rows('sessions').push({
    ...session,
    _id: 'child',
    parent: { sessionId: first.sessionId },
  })
  rows('sessions').push({
    ...session,
    _id: 'copied',
    scheduledTaskId: undefined,
    taskRunId: undefined,
  })
  for (const sessionId of ['child', 'copied']) {
    Object.assign(stream, { sessionId, taskRunId: first._id })
    expect((await read()).approvals?.shell).toEqual(['git status'])
  }
  Object.assign(stream, { sessionId: first.sessionId, taskRunId: first._id })
  await setState(ctx, { taskId, state: 'archived' })
  expect((await read()).approvals?.shell).toEqual(['git status'])
  await expect(
    executionApprovals(ctx, { ...execution, generation: 1 }),
  ).rejects.toThrow('no longer active')
})

test('a grant revoked during a queued call is blocked while a recorded one-time approval remains valid', async () => {
  const { ctx, rows } = policyFixture()
  await save(ctx, { taskId, definition: grantDefinition, reviewedWorkspaceKey })
  const runId = await runNow(ctx, { taskId })
  const sessionId = rows('sessions')[0]._id as Id<'sessions'>
  const streamId = 'stream' as Id<'streams'>
  rows('streams').push({
    _id: streamId,
    generation: 0,
    sessionId,
    taskRunId: runId,
    agentId: 'agent',
    invokedBy: 'owner',
    state: { phase: 'streaming', processingContentId: 'content' },
  })
  const context = {
    sessionId,
    workspaceId: 'project',
    ownerId: sessionId,
    taskApprovals: (call?: FilesystemCall) =>
      executionApprovals(ctx, { streamId, generation: 0, call }),
  }
  const approved = {
    id: 'approved',
    name: 'shell',
    input: { command: 'git status' },
  }
  await expect(
    approvalsForFilesystemCall(
      context,
      { ...approved, id: 'queued' },
      async (snapshot) => {
        expect((await snapshot.approvals?.())?.shell).toEqual(['git checkout'])
        await save(ctx, {
          taskId,
          definition: { ...grantDefinition, approvals: undefined },
        })
        return false
      },
    ),
  ).rejects.toThrow('requires fresh approval')
  expect((await context.taskApprovals()).taskApprovalRevision).toBeUndefined()
  rows('messageContents').push({
    _id: 'content',
    parts: [
      {
        type: 'tool-shell',
        toolCallId: 'approved',
        input: approved.input,
        state: 'approval-responded',
        approval: { approved: true },
      },
    ],
  })
  await expect(
    approvalsForFilesystemCall(context, approved, async () => true),
  ).resolves.toBeDefined()
  await expect(
    approvalsForFilesystemCall(
      context,
      { ...approved, input: { command: 'git diff' } },
      async () => true,
    ),
  ).rejects.toThrow('requires fresh approval')
})

test('unavailable or changed task workspaces settle without launching and notify the owner', async () => {
  for (const removeFolder of [true, false]) {
    const { ctx, rows } = policyFixture()
    await save(ctx, {
      taskId,
      definition: grantDefinition,
      reviewedWorkspaceKey,
    })
    if (removeFolder) rows('sessionFolders').pop()
    else rows('sessionFolders')[0].revision = 2
    let launches = 0
    Object.assign(ctx, {
      runMutation: async () => {
        launches++
      },
    })
    const runId = await runNow(ctx, { taskId })
    expect(launches).toBe(0)
    expect(rows('scheduledTaskRuns')[0]).toMatchObject({
      status: 'failed',
      _id: runId,
    })
    expect(rows('scheduledTaskRuns')[0].detail).toContain(
      removeFolder ? 'workspace is unavailable' : 'Workspace sources changed',
    )
    expect(rows('notifications')[0]).toMatchObject({
      kind: 'task_failed',
      taskRunId: runId,
    })
    expect(rows('scheduledTasks')[0].nextRunAt).toBe(due)
  }
})
