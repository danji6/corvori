import type { DataModel } from '@cv/convex/_generated/dataModel'
import {
  type DataModelFromSchemaDefinition,
  defineSchema,
  defineTable,
} from 'convex/server'
import { v } from 'convex/values'

export const pendingNotifications = defineTable({
  recipientId: v.id('users'),
  membershipId: v.id('userSessions'),
  sessionId: v.id('sessions'),
  sourceMessageId: v.id('messages'),
  sessionTitle: v.string(),
  actorName: v.string(),
  actorAvatarId: v.optional(v.id('avatars')),
  preview: v.string(),
}).index('by_recipientId', ['recipientId'])

export const notificationDrains = defineTable({
  recipientId: v.id('users'),
  generation: v.string(),
  expiresAt: v.number(),
  jobId: v.optional(v.id('_scheduled_functions')),
})
  .index('by_recipientId', ['recipientId'])
  .index('by_expiresAt', ['expiresAt'])

const _schema = defineSchema({ pendingNotifications, notificationDrains })
export type RecipientBatchModel = DataModel &
  DataModelFromSchemaDefinition<typeof _schema>
