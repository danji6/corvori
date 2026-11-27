import { scheduleError } from '@cv/core/task-schedule'
import type { PaginationOptions } from 'convex/server'

import type { Id } from '../../_generated/dataModel'
import type { MutationCtx } from '../../_generated/server'
import { error } from '../../errors'
import type { AuthMutationCtx, AuthQueryCtx } from '../../functions'
import type { ScheduledTaskDefinition, TaskListArgs } from '../../validators/scheduledTasks'
import { requireOwnedAgent } from '../session/sessionAccess'
import { armTask, futureOccurrence, reschedule } from './timing'

type TaskKey = { taskId: Id<'scheduledTasks'> }

export async function get(ctx: AuthQueryCtx, { taskId }: TaskKey) {
  const task = await ctx.db.get(taskId)
  return task?.ownerId === ctx.userId ? task : null
}

export async function findById(ctx: AuthQueryCtx, args: { taskId: string }) {
  const taskId = ctx.db.normalizeId('scheduledTasks', args.taskId)
  return taskId ? get(ctx, { taskId }) : null
}

export async function list(ctx: AuthQueryCtx, args: TaskListArgs) {
  const search = args.search.trim()
  const tasks = ctx.db.query('scheduledTasks')
  const query = search
    ? tasks.withSearchIndex('search_tasks', (q) =>
        q.search('searchText', search).eq('ownerId', ctx.userId),
      )
    : tasks.withIndex('by_owner_state', (q) => q.eq('ownerId', ctx.userId))
  return query
    .filter((q) =>
      args.archived
        ? q.eq(q.field('state'), 'archived')
        : q.neq(q.field('state'), 'archived'),
    )
    .paginate(args.paginationOpts)
}

export async function history(
  ctx: AuthQueryCtx,
  args: TaskKey & { paginationOpts: PaginationOptions },
) {
  if (!(await get(ctx, args))) error('Task not found', 404)
  return ctx.db
    .query('scheduledTaskRuns')
    .withIndex('by_task_due', (q) => q.eq('taskId', args.taskId))
    .order('desc')
    .paginate(args.paginationOpts)
}

export function taskSearchText(
  agentName: string,
  prompt: string,
  title?: string,
) {
  return [title, agentName, prompt].filter(Boolean).join(' ')
}

export async function refreshAgentName(
  ctx: MutationCtx,
  agentId: Id<'agents'>,
  agentName: string,
) {
  const tasks = await ctx.db
    .query('scheduledTasks')
    .withIndex('by_agent', (q) => q.eq('agentId', agentId))
    .collect()
  for (const task of tasks) {
    await ctx.db.patch(task._id, {
      agentName,
      searchText: taskSearchText(agentName, task.prompt, task.title),
    })
  }
}

export async function save(
  ctx: AuthMutationCtx,
  {
    taskId,
    definition,
  }: { taskId?: Id<'scheduledTasks'>; definition: ScheduledTaskDefinition },
) {
  const agent = await requireOwnedAgent(ctx, definition.agentId)
  const title = definition.title?.trim() || undefined
  const prompt = definition.prompt.trim()
  if (!prompt || prompt.length > 16000)
    error('Enter a prompt of up to 16,000 characters.')
  if (title && title.length > 200) error('Keep the title under 201 characters.')
  const issue = scheduleError(definition.schedule)
  if (issue) error(issue)
  const fields = {
    ...definition,
    title,
    prompt,
    agentName: agent.name,
    searchText: taskSearchText(agent.name, prompt, title),
  }
  const next = futureOccurrence(fields.schedule)
  if (taskId) {
    const task = await get(ctx, { taskId })
    if (!task) error('Task not found', 404)
    if (task.state === 'archived') error('This task is archived.')
    await ctx.db.patch(taskId, fields)
    const paused = task.state === 'paused'
    await reschedule(
      ctx,
      task,
      paused ? 'paused' : 'active',
      paused ? undefined : next,
    )
    return taskId
  }
  const id = await ctx.db.insert('scheduledTasks', {
    ...fields,
    ownerId: ctx.userId,
    state: 'active',
    revision: 1,
    nextRunAt: next,
  })
  await armTask(ctx, id, 1, next)
  return id
}

export async function setState(
  ctx: AuthMutationCtx,
  args: TaskKey & { state: 'active' | 'archived' | 'paused' },
) {
  const task = await get(ctx, args)
  if (!task) error('Task not found', 404)
  if (task.state === args.state) return
  if (task.state === 'archived') error('This task is archived.')
  if (args.state === 'active' && task.state !== 'paused')
    error('Only paused tasks can resume.')
  if (
    args.state === 'paused' &&
    (task.state !== 'active' || task.nextRunAt === undefined)
  )
    error('Only active tasks can pause.')
  const next =
    args.state === 'active' ? futureOccurrence(task.schedule) : undefined
  await reschedule(ctx, task, args.state, next)
}
