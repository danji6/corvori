import { type Infer, v } from 'convex/values'

import { messageSenderValidator, senderValidator } from './messages'

export const authorKindValidator = v.union(
  v.literal('user'),
  v.literal('agent'),
  v.literal('system'),
)

export const sessionAuthorSchema = v.object({
  sessionId: v.id('sessions'),
  kind: authorKindValidator,
  name: v.optional(v.string()),
  avatarId: v.optional(v.id('avatars')),
})

export const sessionProfileSchema = v.object({
  sessionId: v.id('sessions'),
  sender: senderValidator,
  name: v.optional(v.string()),
  avatarId: v.optional(v.id('avatars')),
})

export const sessionProfileTargetValidator = v.object({
  sessionId: v.id('sessions'),
  sender: messageSenderValidator,
})

export const updateSessionProfileValidator =
  sessionProfileTargetValidator.extend({
    name: v.optional(v.union(v.string(), v.null())),
    resetAvatar: v.optional(v.boolean()),
  })

export const confirmSessionProfileAvatarValidator =
  sessionProfileTargetValidator.extend({
    originalStorageId: v.id('_storage'),
    thumbStorageId: v.id('_storage'),
    name: v.optional(v.union(v.string(), v.null())),
  })

export type SessionProfileTarget = Infer<typeof sessionProfileTargetValidator>
export type UpdateSessionProfile = Infer<typeof updateSessionProfileValidator>
export type ConfirmSessionProfileAvatar = Infer<
  typeof confirmSessionProfileAvatarValidator
>
