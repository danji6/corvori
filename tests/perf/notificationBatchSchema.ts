import type { DataModel } from '@cv/convex/_generated/dataModel'
import {
  type DataModelFromSchemaDefinition,
  defineSchema,
  defineTable,
} from 'convex/server'
import { v } from 'convex/values'

export const notificationBatches = defineTable({
  sessionId: v.id('sessions'),
  sourceMessageId: v.id('messages'),
  memberships: v.array(v.id('userSessions')),
  sessionTitle: v.string(),
  actorName: v.string(),
  actorAvatarId: v.optional(v.id('avatars')),
  preview: v.string(),
})

const _schema = defineSchema({ notificationBatches })
export type BatchModel = DataModel &
  DataModelFromSchemaDefinition<typeof _schema>
