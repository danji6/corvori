import type { Doc, Id } from '../../_generated/dataModel'
import type { MutationCtx } from '../../_generated/server'
import {
  notificationPreview,
  notifyTaskOutcome,
} from '../notifications/records'
import { armTask } from './timing'

/** Carries the first tool failure across segments, compaction, and follow-up streams. */
export async function recordRunError(
  ctx: MutationCtx,
  runId: Id<'scheduledTaskRuns'>,
  errorText: string,
) {
  const run = await ctx.db.get(runId)
  if (run?.status === 'running' && !run.detail) {
    await ctx.db.patch(runId, {
      detail: notificationPreview(errorText, 'Tool failed'),
    })
  }
}

function transcriptToolError(parts: readonly unknown[]) {
  for (const part of parts) {
    const tool = part as { type?: string; state?: string; errorText?: unknown }

    if (tool?.state !== 'output-error' && tool?.state !== 'output-denied') {
      continue
    }
    if (
      typeof tool.type !== 'string' ||
      !(tool.type.startsWith('tool-') || tool.type === 'dynamic-tool')
    ) {
      continue
    }
    if (typeof tool.errorText === 'string' && tool.errorText.trim()) {
      return tool.errorText
    }

    return tool.state === 'output-denied'
      ? 'Tool execution denied'
      : 'Tool failed'
  }
}

export async function recordTranscriptError(
  ctx: MutationCtx,
  runId: Id<'scheduledTaskRuns'> | undefined,
  segments: { parts: unknown[] }[],
) {
  if (!runId) return
  for (const segment of segments) {
    const failure = transcriptToolError(segment.parts)
    if (failure) return recordRunError(ctx, runId, failure)
  }
}

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

/** Ends scheduled attribution before a new chat input can enter the same stream. */
export async function interruptRun(ctx: MutationCtx, stream: Doc<'streams'>) {
  if (!stream.taskRunId) return
  await settleRun(
    ctx,
    stream.taskRunId,
    'failed',
    'Turn interrupted by a new message.',
  )
  await ctx.db.patch(stream._id, { taskRunId: undefined })
}

export async function settleStoppedRun(
  ctx: MutationCtx,
  runId?: Id<'scheduledTaskRuns'>,
) {
  if (runId)
    await settleRun(ctx, runId, 'failed', 'Turn stopped before completion.')
}
