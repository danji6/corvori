import { type Infer, v } from 'convex/values'

export const todoStatusValidator = v.union(
  v.literal('pending'),
  v.literal('in_progress'),
  v.literal('completed'),
)

export type TodoStatus = Infer<typeof todoStatusValidator>

export const todoItemValidator = v.object({
  content: v.string(),
  status: todoStatusValidator,
})

export type TodoItem = Infer<typeof todoItemValidator>

/** A session’s task list and reminder progress. */
export const todoSchema = v.object({
  sessionId: v.id('sessions'),
  items: v.array(todoItemValidator),
  /** Session stepCount at last write or nudge reminder. */
  stepCount: v.number(),
  updatedAt: v.number(),
})
