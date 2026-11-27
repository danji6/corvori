import { paginationOptsValidator } from 'convex/server'
import { type Infer, v } from 'convex/values'

import { reasoningEffortValidator } from './providers'

const schedule = v.object({
  startDate: v.string(),
  time: v.string(),
  zone: v.string(),
  repeat: v.union(
    v.object({ kind: v.literal('once') }),
    v.object({ kind: v.literal('minutes'), every: v.number() }),
    v.object({ kind: v.literal('hours'), every: v.number() }),
    v.object({ kind: v.literal('daily'), every: v.number() }),
    v.object({
      kind: v.literal('weekly'),
      every: v.number(),
      weekdays: v.array(v.number()),
    }),
    v.object({
      kind: v.literal('monthly'),
      every: v.number(),
      pattern: v.union(v.literal('date'), v.literal('weekday')),
    }),
  ),
})

const taskApprovals = v.object({
  shell: v.array(v.string()),
  paths: v.array(v.string()),
})

export const taskDefinition = v.object({
  title: v.optional(v.string()),
  agentId: v.id('agents'),
  folderId: v.optional(v.id('sessionFolders')),
  approvals: v.optional(taskApprovals),
  modelId: v.optional(v.string()),
  reasoningEffort: v.optional(reasoningEffortValidator),
  prompt: v.string(),
  schedule,
})

export const taskState = v.union(
  v.literal('active'),
  v.literal('paused'),
  v.literal('finished'),
  v.literal('archived'),
)
export const runStatus = v.union(
  v.literal('running'),
  v.literal('succeeded'),
  v.literal('failed'),
)
export const taskSchema = v.object({
  ...taskDefinition.fields,
  approvalRevision: v.optional(v.number()),
  approvalWorkspaceKey: v.optional(v.string()),
  ownerId: v.id('users'),
  agentName: v.string(),
  searchText: v.string(),
  state: taskState,
  nextRunAt: v.optional(v.number()),
  revision: v.number(),
  jobId: v.optional(v.id('_scheduled_functions')),
  activeRunId: v.optional(v.id('scheduledTaskRuns')),
  latestStatus: v.optional(runStatus),
})

export const runSchema = v.object({
  taskId: v.id('scheduledTasks'),
  sessionId: v.optional(v.id('sessions')),
  approvalRevision: v.optional(v.number()),
  scheduledFor: v.number(),
  trigger: v.optional(v.literal('manual')),
  skippedFrom: v.optional(v.number()),
  startedAt: v.number(),
  promptMessageId: v.optional(v.id('messages')),
  finishedAt: v.optional(v.number()),
  status: runStatus,
  title: v.string(),
  prompt: v.string(),
  agentId: v.id('agents'),
  agentName: v.string(),
  zone: v.string(),
  detail: v.optional(v.string()),
})

export const dispatchArgs = v.object({
  taskId: v.id('scheduledTasks'),
  revision: v.number(),
  due: v.number(),
})

export const listArgs = v.object({
  search: v.string(),
  archived: v.boolean(),
  paginationOpts: paginationOptsValidator,
})

export type ScheduledTaskDefinition = Infer<typeof taskDefinition>
export type TaskApprovals = Infer<typeof taskApprovals>
export type TaskDispatchArgs = Infer<typeof dispatchArgs>
export type TaskListArgs = Infer<typeof listArgs>
