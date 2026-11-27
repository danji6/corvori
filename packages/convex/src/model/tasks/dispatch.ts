import { occurrence } from '@cv/core/task-schedule'

import { internal } from '../../_generated/api'
import type { Doc, Id } from '../../_generated/dataModel'
import type { MutationCtx } from '../../_generated/server'
import { error, sanitizeChatError } from '../../errors'
import type { AuthMutationCtx } from '../../functions'
import type { TaskDispatchArgs } from '../../validators/scheduledTasks'
import { sendMessage } from '../chat/send'
import { workspaceKey } from '../session/folderContext'
import { create as createSession } from '../session/sessions'
import { requireTaskWorkspace } from './approvalPolicy'
import { get, validateTaskModel } from './definitions'
import { settleRun } from './outcomes'
import { armTask } from './timing'

async function ownerContext(ctx: MutationCtx, ownerId: Id<'users'>) {
  const owner = await ctx.db.get(ownerId)
  if (!owner) error('Task owner no longer exists', 404)
  return { ...ctx, userId: ownerId, subject: owner.subject, role: owner.role }
}

type RunTiming = Pick<
  Doc<'scheduledTaskRuns'>,
  'scheduledFor' | 'startedAt' | 'trigger'
>

async function createRun(
  ctx: MutationCtx,
  task: Doc<'scheduledTasks'>,
  timing: RunTiming,
  title: string,
  agentName: string,
) {
  const caughtUp = !timing.trigger && task.nextRunAt !== timing.scheduledFor
  return ctx.db.insert('scheduledTaskRuns', {
    taskId: task._id,
    ...timing,
    approvalRevision: task.approvals ? task.approvalRevision : undefined,
    skippedFrom: caughtUp ? task.nextRunAt : undefined,
    status: 'running',
    title,
    prompt: task.prompt,
    agentId: task.agentId,
    agentName,
    zone: task.schedule.zone,
  })
}

async function workspaceFailure(ctx: MutationCtx, task: Doc<'scheduledTasks'>) {
  try {
    const workspace = await requireTaskWorkspace(
      ctx,
      task.ownerId,
      task.folderId,
    )
    if (
      task.approvals &&
      task.approvalWorkspaceKey !== workspaceKey(workspace)
    ) {
      return 'Workspace sources changed. Review automatic approvals in the task editor.'
    }
  } catch {
    return 'Task workspace is unavailable. Choose a workspace in the task editor.'
  }
}

async function claim(
  ctx: MutationCtx,
  task: Doc<'scheduledTasks'>,
  timing: RunTiming,
) {
  const agent = await ctx.db.get(task.agentId)
  const title = task.title || task.prompt.split('\n', 1)[0].slice(0, 120)
  const runId = await createRun(
    ctx,
    task,
    timing,
    title,
    agent?.name ?? task.agentName,
  )
  const owner = await ownerContext(ctx, task.ownerId)
  const failure = await workspaceFailure(ctx, task)
  const { sessionId } = await createSession(owner, {
    title,
    folderId: failure ? undefined : task.folderId,
    activeAgentId: agent?.ownerId === owner.userId ? agent._id : undefined,
    scheduledTaskId: task._id,
    taskRunId: runId,
    modelId: task.modelId,
    reasoningEffort: task.reasoningEffort,
  })
  await ctx.db.patch(runId, { sessionId })
  return { runId, agent, failure }
}

async function startRun(
  ctx: MutationCtx,
  task: Doc<'scheduledTasks'>,
  timing: RunTiming,
): Promise<Id<'scheduledTaskRuns'>> {
  const { runId, agent, failure } = await claim(ctx, task, timing)
  const nextRunAt =
    timing.trigger === 'manual'
      ? task.nextRunAt
      : occurrence(task.schedule, timing.startedAt, 'next')
  await ctx.db.patch(task._id, {
    activeRunId: runId,
    latestStatus: 'running',
    nextRunAt,
    jobId: undefined,
  })
  try {
    if (failure) error(failure)
    if (agent)
      await validateTaskModel(ctx, task.ownerId, task, agent.modelOverride)
    // A failed launch rolls back its partial transcript and reservation independently.
    await ctx.runMutation(internal.scheduledTasks._launch, { runId })
  } catch (cause) {
    await settleRun(ctx, runId, 'failed', sanitizeChatError(cause))
  }
  return runId
}

export async function runNow(
  ctx: AuthMutationCtx,
  { taskId }: { taskId: Id<'scheduledTasks'> },
): Promise<Id<'scheduledTaskRuns'>> {
  const task = await get(ctx, { taskId })
  if (!task) error('Task not found', 404)
  if (task.state === 'archived') error('This task is archived.')
  if (task.activeRunId) error('This task already has a running session.', 409)
  if (task.jobId) await ctx.scheduler.cancel(task.jobId)
  const now = Date.now()
  return startRun(ctx, task, {
    scheduledFor: now,
    startedAt: now,
    trigger: 'manual',
  })
}

export async function dispatch(
  ctx: MutationCtx,
  { taskId, revision, due }: TaskDispatchArgs,
): Promise<void> {
  const task = await ctx.db.get(taskId)
  if (!task || task.state !== 'active' || task.activeRunId) return
  if (task.revision !== revision || task.nextRunAt !== due) return
  const now = Date.now()
  if (due > now) return
  const scheduledFor = occurrence(task.schedule, now, 'latest') ?? due
  const matchingRuns = await ctx.db
    .query('scheduledTaskRuns')
    .withIndex('by_task_due', (q) =>
      q.eq('taskId', taskId).eq('scheduledFor', scheduledFor),
    )
    .collect()
  if (matchingRuns.some((run) => run.trigger !== 'manual')) {
    const nextRunAt = occurrence(task.schedule, now, 'next')
    await ctx.db.patch(taskId, {
      nextRunAt,
      jobId: undefined,
      state: nextRunAt === undefined ? 'finished' : 'active',
    })
    if (nextRunAt !== undefined) await armTask(ctx, taskId, revision, nextRunAt)
    return
  }
  await startRun(ctx, task, { scheduledFor, startedAt: now })
}

export async function launch(
  ctx: MutationCtx,
  { runId }: { runId: Id<'scheduledTaskRuns'> },
): Promise<void> {
  const run = await ctx.db.get(runId)
  if (!run?.sessionId || run.status !== 'running' || run.promptMessageId) return
  const session = await ctx.db.get(run.sessionId)
  if (session?.activeAgentId !== run.agentId)
    error('Assigned agent is no longer available.')
  const promptMessageId = await sendMessage(
    await ownerContext(ctx, session.ownerId),
    { sessionId: session._id, content: run.prompt },
    runId,
  )
  await ctx.db.patch(runId, { promptMessageId })
}

export async function recover(ctx: MutationCtx) {
  const due = await ctx.db
    .query('scheduledTasks')
    .withIndex('by_due', (q) =>
      q
        .eq('state', 'active')
        .eq('activeRunId', undefined)
        .gt('nextRunAt', undefined)
        .lte('nextRunAt', Date.now()),
    )
    .take(64)
  for (const task of due) {
    await ctx.scheduler.runAfter(0, internal.scheduledTasks._dispatch, {
      taskId: task._id,
      revision: task.revision,
      due: task.nextRunAt!,
    })
  }
}
