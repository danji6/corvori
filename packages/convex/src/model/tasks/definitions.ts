import { MAX_TASK_PROMPT_CHARS } from '@cv/core/limits'
import { normalizeReasoningEffort } from '@cv/core/model-reasoning'
import { stableStringify } from '@cv/core/stable-json'
import { scheduleError } from '@cv/core/task-schedule'
import type { AgentModelOverride } from '@cv/core/types'
import type { PaginationOptions } from 'convex/server'

import type { Id } from '../../_generated/dataModel'
import type { MutationCtx } from '../../_generated/server'
import { error } from '../../errors'
import type { AuthMutationCtx, AuthQueryCtx } from '../../functions'
import type {
  ScheduledTaskDefinition,
  TaskListArgs,
} from '../../validators/scheduledTasks'
import { unavailableModelOverride } from '../agent/modelOverride'
import { resolveModelReasoning } from '../provider/known'
import { getSavedModel } from '../provider/providers'
import { requireOwnedAgent } from '../session/sessionAccess'
import { saveApprovalPolicy } from './approvalPolicy'
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

export async function runDestination(
  ctx: AuthQueryCtx,
  { runId }: { runId: string },
) {
  const id = ctx.db.normalizeId('scheduledTaskRuns', runId)
  const run = id && (await ctx.db.get(id))
  if (!run || !(await get(ctx, { taskId: run.taskId }))) return null
  return { taskId: run.taskId, sessionId: run.sessionId }
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

type TaskModelSelection = Pick<
  ScheduledTaskDefinition,
  'modelId' | 'reasoningEffort'
>

export async function validateTaskModel(
  ctx: MutationCtx,
  ownerId: Id<'users'>,
  selection: TaskModelSelection,
  override?: AgentModelOverride,
): Promise<TaskModelSelection> {
  const modelId = override?.modelId ?? selection.modelId
  if (!modelId) error('Choose a model in the task editor.')

  const saved = await getSavedModel(ctx, ownerId, modelId)
  if (!saved || saved.model.available === false) {
    if (override) error(unavailableModelOverride(override.modelId), 409)
    error('The task model is unavailable. Choose an available model.')
  }

  const capability = resolveModelReasoning(
    saved.providerId,
    saved.model.reasoning,
  )
  const taskEffortRequired =
    capability.type !== 'none' && override?.reasoningEffort === undefined
  const reasoningEffort = taskEffortRequired
    ? selection.reasoningEffort
    : undefined
  if (
    taskEffortRequired &&
    normalizeReasoningEffort(reasoningEffort, capability) !== reasoningEffort
  ) {
    error('Choose a supported reasoning effort in the task editor.')
  }

  return { modelId: override ? undefined : saved.id, reasoningEffort }
}

export async function save(
  ctx: AuthMutationCtx,
  {
    taskId,
    definition,
    reviewedWorkspaceKey,
  }: {
    taskId?: Id<'scheduledTasks'>
    definition: ScheduledTaskDefinition
    reviewedWorkspaceKey?: string
  },
) {
  const task = taskId ? await get(ctx, { taskId }) : null
  if (taskId && !task) error('Task not found', 404)
  if (task?.state === 'archived') error('This task is archived.')

  const agent = await requireOwnedAgent(ctx, definition.agentId)
  const title = definition.title?.trim() || undefined
  const prompt = definition.prompt.trim()
  if (!prompt || prompt.length > MAX_TASK_PROMPT_CHARS) {
    error('Enter a prompt of up to 16,000 characters.')
  }
  if (title && title.length > 200) {
    error('Keep the title under 201 characters.')
  }

  const issue = scheduleError(definition.schedule)
  if (issue) error(issue)

  const model = await validateTaskModel(
    ctx,
    ctx.userId,
    definition,
    agent.modelOverride,
  )
  const policy = await saveApprovalPolicy(
    ctx,
    definition,
    task,
    reviewedWorkspaceKey,
  )
  const fields = {
    ...definition,
    ...model,
    ...policy,
    folderId: definition.folderId,
    title,
    prompt,
    agentName: agent.name,
    searchText: taskSearchText(agent.name, prompt, title),
  }

  if (task) {
    const scheduleChanged =
      stableStringify(task.schedule) !== stableStringify(fields.schedule)
    const next = scheduleChanged ? futureOccurrence(fields.schedule) : undefined
    await ctx.db.patch(task._id, fields)
    if (!scheduleChanged) return task._id
    const paused = task.state === 'paused'
    await reschedule(
      ctx,
      task,
      paused ? 'paused' : 'active',
      paused ? undefined : next,
    )
    return task._id
  }

  const next = futureOccurrence(fields.schedule)
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
  ) {
    error('Only active tasks can pause.')
  }
  const next =
    args.state === 'active' ? futureOccurrence(task.schedule) : undefined
  await reschedule(ctx, task, args.state, next)
}

export async function unarchive(ctx: AuthMutationCtx, args: TaskKey) {
  const task = await get(ctx, args)
  if (!task) error('Task not found', 404)
  if (task.state !== 'archived') return

  // Restoring a task must not reactivate grants for a run started before archiving.
  if (task.approvals) {
    await ctx.db.patch(task._id, {
      approvalRevision: (task.approvalRevision ?? 0) + 1,
    })
  }
  await reschedule(ctx, task, 'paused')
}
