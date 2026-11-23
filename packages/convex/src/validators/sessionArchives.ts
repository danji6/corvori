import { v } from 'convex/values'

import {
  messageExtraValidator,
  messageMetaValidator,
  messageTypeValidator,
  roleValidator,
} from './messages'
import { authorKindValidator } from './sessionAuthors'

export const sessionArchiveSenderSnapshotValidator = v.object({
  name: v.string(),
  avatarKey: v.optional(v.string()),
})

export const sessionArchiveAvatarValidator = v.object({
  key: v.string(),
  mediaType: v.string(),
  data: v.string(),
})

const messageFields = {
  role: roleValidator,
  type: v.optional(messageTypeValidator),
  hidden: v.optional(v.boolean()),
  extra: v.optional(messageExtraValidator),
  parts: v.array(v.any()),
  metadata: v.optional(messageMetaValidator),
}

export const legacySessionArchiveValidator = v.object({
  version: v.literal(1),
  exportedAt: v.number(),
  avatars: v.optional(v.array(sessionArchiveAvatarValidator)),
  session: v.object({
    title: v.string(),
    messages: v.array(
      v.object({
        ...messageFields,
        senderSnapshot: v.optional(sessionArchiveSenderSnapshotValidator),
      }),
    ),
  }),
})

export const currentSessionArchiveValidator = v.object({
  version: v.literal(2),
  exportedAt: v.number(),
  avatars: v.optional(v.array(sessionArchiveAvatarValidator)),
  session: v.object({
    title: v.string(),
    authors: v.array(
      v.object({
        key: v.string(),
        kind: authorKindValidator,
        name: v.optional(v.string()),
        avatarKey: v.optional(v.string()),
      }),
    ),
    messages: v.array(
      v.object({
        ...messageFields,
        authorKey: v.string(),
        senderName: v.optional(v.union(v.string(), v.null())),
        replyTo: v.optional(
          v.object({
            authorKey: v.string(),
            senderName: v.union(v.string(), v.null()),
            text: v.string(),
            rendered: v.optional(v.literal(true)),
            targetIndex: v.optional(v.number()),
          }),
        ),
      }),
    ),
  }),
})

export const sessionArchiveValidator = v.union(
  legacySessionArchiveValidator,
  currentSessionArchiveValidator,
)
