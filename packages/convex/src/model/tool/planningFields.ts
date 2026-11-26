import {
  MAX_PLAN_CONTENT_CHARS,
  MAX_TODO_CONTENT_CHARS,
  MAX_TODO_ITEMS,
} from '@cv/core/limits'
import { editFileFields } from '@cv/core/types/workspace-tools'
import { z } from 'zod'

export const writePlanFields = {
  content: z
    .string()
    .max(MAX_PLAN_CONTENT_CHARS)
    .describe('Complete plan content (markdown)'),
} as const

export const editPlanFields = { edits: editFileFields.edits } as const

export const planModeFields = {} as const

export const writeTodoFields = {
  todos: z
    .array(z.string().min(1).max(MAX_TODO_CONTENT_CHARS))
    .max(MAX_TODO_ITEMS)
    .describe('Every task as a short string; replaces the previous list'),
} as const

export const editTodoFields = {
  edits: z.array(
    z.object({
      task: z.string().describe('Exact text of an existing task'),
      status: z.enum(['todo', 'doing', 'done']),
    }),
  ),
} as const
