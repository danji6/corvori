import {
  EDIT_TODO_TOOL_NAME,
  TODO_EDIT_STATUSES,
  WRITE_TODO_TOOL_NAME,
} from '@cv/core/const'
import { TOOL_DESCRIPTIONS } from '@cv/core/types'

import { internal } from '../../_generated/api'
import { ToolError } from '../../errors'
import type { PlanToolContext } from './context'
import { editTodoFields, writeTodoFields } from './planningFields'

export async function createWriteTodoTool(context: PlanToolContext) {
  const [{ tool }, { z }] = await Promise.all([import('ai'), import('zod')])
  return tool({
    description: TOOL_DESCRIPTIONS[WRITE_TODO_TOOL_NAME],
    inputSchema: z.object(writeTodoFields),
    execute: async ({ todos }) => {
      await context.ctx.runMutation(internal.todos._write, {
        sessionId: context.sessionId,
        todos,
      })
      return todos.length === 0 ? 'Todos cleared.' : 'Todos updated.'
    },
  })
}

export async function createEditTodoTool(context: PlanToolContext) {
  const [{ tool }, { z }] = await Promise.all([import('ai'), import('zod')])
  return tool({
    description: TOOL_DESCRIPTIONS[EDIT_TODO_TOOL_NAME],
    inputSchema: z.object(editTodoFields),
    execute: async ({ edits }) => {
      const result = await context.ctx.runMutation(internal.todos._edit, {
        sessionId: context.sessionId,
        edits: edits.map(({ task, status }) => ({
          task,
          status: TODO_EDIT_STATUSES[status],
        })),
      })
      if (!result.ok) throw new ToolError(result.error)
      return 'Todos updated.'
    },
  })
}
