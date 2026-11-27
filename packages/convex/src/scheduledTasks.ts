import { paginationOptsValidator } from 'convex/server'
import { v } from 'convex/values'

import { internalMutation } from './_generated/server'
import { authMutation, authQuery } from './functions'
import * as Tasks from './model/tasks/definitions'
import * as Dispatch from './model/tasks/dispatch'
import {
  dispatchArgs,
  listArgs,
  taskDefinition,
} from './validators/scheduledTasks'

const taskId = v.id('scheduledTasks')
export const list = authQuery({
  args: listArgs.fields,
  handler: Tasks.list,
})
export const get = authQuery({
  args: { taskId: v.string() },
  handler: Tasks.findById,
})
export const runDestination = authQuery({
  args: { runId: v.string() },
  handler: Tasks.runDestination,
})
export const history = authQuery({
  args: { taskId, paginationOpts: paginationOptsValidator },
  handler: Tasks.history,
})
export const save = authMutation({
  args: { taskId: v.optional(taskId), definition: taskDefinition },
  handler: Tasks.save,
})
export const setState = authMutation({
  args: {
    taskId,
    state: v.union(
      v.literal('active'),
      v.literal('paused'),
      v.literal('archived'),
    ),
  },
  handler: Tasks.setState,
})
export const _dispatch = internalMutation({
  args: dispatchArgs.fields,
  handler: Dispatch.dispatch,
})
export const _launch = internalMutation({
  args: { runId: v.id('scheduledTaskRuns') },
  handler: Dispatch.launch,
})
export const _recover = internalMutation({
  args: {},
  handler: Dispatch.recover,
})
