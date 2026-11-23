import { type Infer, v } from 'convex/values'

/** Slash commands that wait for an idle session before they execute. */
export const deferredCommandNameValidator = v.union(
  v.literal('compact'),
  v.literal('eval'),
  v.literal('impersonate'),
  v.literal('new'),
  v.literal('resume'),
)

export type DeferredCommandName = Infer<typeof deferredCommandNameValidator>

/** Slash commands represented by hidden command chips. */
export const commandNameValidator = v.union(
  deferredCommandNameValidator,
  v.literal('timeout'),
  v.literal('autoCompact'),
)

export type CommandName = Infer<typeof commandNameValidator>

/** One command awaiting an idle session, optionally with an announcing chip. */
export const queuedCommandValidator = v.object({
  name: deferredCommandNameValidator,
  argument: v.optional(v.string()),
  invokedBy: v.id('users'),
  requestId: v.optional(v.string()),
  messageId: v.optional(v.id('messages')),
})

export type QueuedCommand = Infer<typeof queuedCommandValidator>

/** How far a queued command got, rendered by its chip. */
export const commandStatusValidator = v.union(
  v.literal('queued'),
  v.literal('ran'),
  v.literal('failed'),
  v.literal('cancelled'),
)

export type CommandStatus = Infer<typeof commandStatusValidator>

export const commandExtraValidator = v.object({
  name: commandNameValidator,
  argument: v.optional(v.string()),
  source: v.optional(v.literal('contextWindow')),
  status: commandStatusValidator,
  error: v.optional(v.string()),
  reason: v.optional(v.string()),
})
