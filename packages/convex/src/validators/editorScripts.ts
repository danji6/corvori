import { type Infer, v } from 'convex/values'

export const createScriptArgsValidator = v.object({
  name: v.string(),
  code: v.string(),
  icon: v.optional(v.string()),
  pinned: v.optional(v.boolean()),
  order: v.optional(v.number()),
})

export type CreateScriptArgs = Infer<typeof createScriptArgsValidator>

export const updateScriptArgsValidator = v.object({
  scriptId: v.id('editorScripts'),
  name: v.optional(v.string()),
  code: v.optional(v.string()),
  icon: v.optional(v.string()),
  pinned: v.optional(v.boolean()),
  order: v.optional(v.number()),
})

export type UpdateScriptArgs = Infer<typeof updateScriptArgsValidator>

/** A message editor script. */
export const editorScriptSchema = v.object({
  name: v.string(),
  ownerId: v.id('users'),
  code: v.string(),
  icon: v.string(),
  pinned: v.boolean(),
  order: v.number(),
})
