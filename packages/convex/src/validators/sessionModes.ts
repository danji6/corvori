import { type Infer, v } from 'convex/values'

export const sessionModeValidator = v.union(
  v.literal('normal'),
  v.literal('plan'),
  v.literal('ask'),
)

export type SessionMode = Infer<typeof sessionModeValidator>
