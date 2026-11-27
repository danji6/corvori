import { occurrence } from '@cv/core/task-schedule'

import { internal } from '../../_generated/api'
import type { Doc, Id } from '../../_generated/dataModel'
import type { MutationCtx } from '../../_generated/server'
import { error, sanitizeChatError } from '../../errors'
import type { TaskDispatchArgs } from '../../validators/scheduledTasks'
import { sendMessage } from '../chat/send'
import { create as createSession } from '../session/sessions'
import { settleRun } from './outcomes'
import { armTask } from './timing'

async function ownerContext(ctx: MutationCtx, ownerId: Id<'users'>) {
  const owner = await ctx.db.get(ownerId)
  if (!owner) error('Task owner no longer exists', 404)
  return { ...ctx, userId: ownerId, subject: owner.subject, role: owner.role }
}

async function createRun(
  ctx: MutationCtx,
  task: Doc<'scheduledTasks'>,
  scheduledFor: number,
  now: number,
  title: string,
  agentName: string,
) {
  return ctx.db.insert('scheduledTaskRuns', {
    taskId: task._id,
    scheduledFor,
    skippedFrom: task.nextRunAt === scheduledFor ? undefined : task.nextRunAt,
    startedAt: now,
    status: 'running',
    title,
    prompt: task.prompt,
    agentId: task.agentId,
    agentName,
    zone: task.schedule.zone,
  })
}

async function claim(
  ctx: MutationCtx,
  task: Doc<'scheduledTasks'>,
  scheduledFor: number,
  now: number,
) {
  const agent = await ctx.db.get(task.agentId)
  const title = task.title || task.prompt.split('\n', 1)[0].slice(0, 120)
  const runId = await createRun(
    ctx,
    task,
    scheduledFor,
    now,
    title,
    agent?.name ?? task.agentName,
  )
  const owner = await ownerContext(ctx, task.ownerId)
  const { sessionId } = await createSession(owner, {
    title,
    activeAgentId: agent?.ownerId === owner.userId ? agent._id : undefined,
    scheduledTaskId: task._id,
    taskRunId: runId,
  })
  await ctx.db.patch(runId, { sessionId })
  const nextRunAt = occurrence(task.schedule, now, 'next')
  await ctx.db.patch(task._id, {
    activeRunId: runId,
    latestStatus: 'running',
    nextRunAt,
    jobId: undefined,
  })
  return runId
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
  const existing = await ctx.db
    .query('scheduledTaskRuns')
    .withIndex('by_task_due', (q) =>
      q.eq('taskId', taskId).eq('scheduledFor', scheduledFor),
    )
    .unique()
  if (existing) {
    const nextRunAt = occurrence(task.schedule, now, 'next')
    await ctx.db.patch(taskId, {
      nextRunAt,
      jobId: undefined,
      state: nextRunAt === undefined ? 'finished' : 'active',
    })
    if (nextRunAt !== undefined) await armTask(ctx, taskId, revision, nextRunAt)
    return
  }
  const runId = await claim(ctx, task, scheduledFor, now)
  try {
    // A failed launch rolls back its partial transcript and reservation independently.
    await ctx.runMutation(internal.scheduledTasks._launch, { runId })
  } catch (cause) {
    await settleRun(ctx, runId, 'failed', sanitizeChatError(cause))
  }
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
