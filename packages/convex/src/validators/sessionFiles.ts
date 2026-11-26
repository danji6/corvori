import { v } from 'convex/values'

export const sessionTaskDirectorySchema = v.object({
  rootId: v.id('sessions'),
  name: v.string(),
})

const operationFields = {
  sessionId: v.id('sessions'),
  nextAttemptAt: v.number(),
  attempt: v.optional(v.number()),
}

export const sessionFileOperationSchema = v.union(
  v.object({ ...operationFields, kind: v.literal('delete') }),
  v.object({
    ...operationFields,
    kind: v.literal('duplicate'),
    sourceId: v.id('sessions'),
    sessionIds: v.array(v.id('sessions')),
    token: v.string(),
  }),
)
