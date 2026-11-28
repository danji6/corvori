import { occurrence } from '@cv/core/task-schedule'

import { internal } from '../../_generated/api'
import type { Doc, Id } from '../../_generated/dataModel'
import type { MutationCtx } from '../../_generated/server'
import { error } from '../../errors'

export function futureOccurrence(schedule: Doc<'scheduledTasks'>['schedule']) {
  const due = occurrence(schedule, Date.now(), 'next')
  if (due === undefined) error('Choose a future time for this task.')
  return due
}

export async function armTask(
  ctx: MutationCtx,
  taskId: Id<'scheduledTasks'>,
  revision: number,
  due: number,
) {
  const jobId = await ctx.scheduler.runAt(
    due,
    internal.scheduledTasks._dispatch,
    { taskId, revision, due },
  )
  await ctx.db.patch(taskId, { jobId })
}

/** Replaces pending work; a running task arms its next wake-up on settlement. */
export async function reschedule(
  ctx: MutationCtx,
  task: Doc<'scheduledTasks'>,
  state: Doc<'scheduledTasks'>['state'],
  nextRunAt?: number,
) {
  if (task.jobId) await ctx.scheduler.cancel(task.jobId)
  const revision = task.revision + 1
  await ctx.db.patch(task._id, { state, nextRunAt, revision, jobId: undefined })
  if (nextRunAt !== undefined && !task.activeRunId)
    await armTask(ctx, task._id, revision, nextRunAt)
}
