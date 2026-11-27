import type { Id } from '../../_generated/dataModel'
import type { MutationCtx } from '../../_generated/server'
import { notificationPreview, notifyTaskOutcome } from '../notifications/records'
import { armTask } from './timing'

/** Commits the first terminal outcome, its inbox entry, and the next wake-up together. */
export async function settleRun(
  ctx: MutationCtx,
  runId: Id<'scheduledTaskRuns'>,
  status: 'succeeded' | 'failed',
  detail: string,
) {
  const run = await ctx.db.get(runId)
  if (!run || run.status !== 'running') return
  const task = await ctx.db.get(run.taskId)
  if (!task || task.activeRunId !== runId) return
  const priorError = status === 'succeeded' ? run.detail : undefined
  if (priorError) status = 'failed'
  const preview = notificationPreview(
    priorError || detail,
    status === 'succeeded' ? 'Task completed' : 'Task failed',
  )
  await ctx.db.patch(runId, { status, detail: preview, finishedAt: Date.now() })
  const exhausted = task.state === 'active' && task.nextRunAt === undefined
  await ctx.db.patch(task._id, {
    activeRunId: undefined,
    latestStatus: status,
    state: exhausted ? 'finished' : task.state,
  })
  if (run.sessionId) {
    await notifyTaskOutcome(ctx, {
      recipientId: task.ownerId,
      sessionId: run.sessionId,
      taskRunId: runId,
      kind: status === 'succeeded' ? 'task_succeeded' : 'task_failed',
      sessionTitle: run.title,
      actorName: run.agentName,
      preview,
    })
  }
  if (task.state === 'active' && task.nextRunAt !== undefined) {
    await armTask(ctx, task._id, task.revision, task.nextRunAt)
  }
}

export async function settleStoppedRun(
  ctx: MutationCtx,
  runId?: Id<'scheduledTaskRuns'>,
) {
  if (runId)
    await settleRun(ctx, runId, 'failed', 'Turn stopped before completion.')
}
