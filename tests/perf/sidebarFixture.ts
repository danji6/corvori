import type { Id } from '@cv/convex/_generated/dataModel'
import {
  type MutationCtx,
  internalMutation,
} from '@cv/convex/_generated/server'
import { authQuery } from '@cv/convex/functions'
import { getMembership } from '@cv/convex/model/session/memberships'
import { v } from 'convex/values'

/** Slide the original query into the same deployment for a paired comparison. */
export const baseline = authQuery({
  args: {},
  handler: async (ctx) => {
    const streams = await ctx.db.query('streams').collect()
    const sessionIds = [...new Set(streams.map((row) => row.sessionId))]
    const visible = await Promise.all(
      sessionIds.map(async (id) =>
        (await getMembership(ctx, id, ctx.userId)) ? id : null,
      ),
    )
    return visible.filter((id) => id !== null)
  },
})

export const _seed = internalMutation({
  args: { viewerIds: v.array(v.id('users')) },
  handler: async (ctx, { viewerIds }) => {
    const ownerId = viewerIds[0]
    const agentId = await ctx.db.insert('agents', {
      ownerId,
      name: 'Perf agent',
    })
    const folderId = await ctx.db.insert('sessionFolders', {
      ownerId,
      name: 'Perf folder',
      position: 0,
      sources: [],
      revision: 0,
    })
    const backgroundId = await ctx.db.insert('users', {
      subject: 'perf-background',
      role: 'user',
    })
    const privateIds = await Promise.all(
      Array.from({ length: 128 }, (_, index) =>
        insertSession(ctx, viewerIds[index] ?? backgroundId, index),
      ),
    )
    const extraIds = await Promise.all(
      Array.from({ length: 39 }, (_, index) =>
        insertSession(ctx, ownerId, 128 + index, folderId),
      ),
    )
    return { privateIds, extraIds, agentId, ownerId, folderId }
  },
})

async function insertSession(
  ctx: MutationCtx,
  ownerId: Id<'users'>,
  index: number,
  folderId?: Id<'sessionFolders'>,
) {
  const title = `Perf chat ${String(index).padStart(3, '0')}`
  const lastMessageAt = Date.now() - index * 1000
  const sessionId = await ctx.db.insert('sessions', {
    ownerId,
    title,
    lastMessageAt,
    folderId,
  })
  await ctx.db.insert('userSessions', {
    userId: ownerId,
    sessionId,
    title,
    lastMessageAt,
    folderId,
    role: 'owner',
    groupKey: folderId ?? 'ungrouped',
  })
  return sessionId
}

const streamInputs = {
  agentId: v.id('agents'),
  invokedBy: v.id('users'),
  sessionIds: v.array(v.id('sessions')),
}

export const _start = internalMutation({
  args: streamInputs,
  handler: async (ctx, { agentId, invokedBy, sessionIds }) =>
    Promise.all(
      sessionIds.map((sessionId) =>
        ctx.db.insert('streams', {
          sessionId,
          agentId,
          invokedBy,
          command: { kind: 'invoke' },
          state: { phase: 'reserved' },
          attempt: 1,
          generation: 1,
          leaseExpiresAt: Date.now() + 60 * 60 * 1000,
        }),
      ),
    ),
})

export const _updateOrStop = internalMutation({
  args: { streamIds: v.array(v.id('streams')), stop: v.boolean() },
  handler: async (ctx, { streamIds, stop }) => {
    await Promise.all(
      streamIds.map((id) =>
        stop ? ctx.db.delete(id) : ctx.db.patch(id, { stopAt: Date.now() }),
      ),
    )
  },
})

export const _share = internalMutation({
  args: {
    userId: v.id('users'),
    sessionId: v.id('sessions'),
    share: v.boolean(),
  },
  handler: async (ctx, { userId, sessionId, share }) => {
    if (share) {
      await ctx.db.insert('userSessions', { userId, sessionId, role: 'member' })
    } else {
      const member = await getMembership(ctx, sessionId, userId)
      if (member) await ctx.db.delete(member._id)
    }
  },
})
