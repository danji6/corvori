import { internalMutation } from '@cv/convex/_generated/server'
import { error } from '@cv/convex/errors'
import { authQuery } from '@cv/convex/functions'
import { set as setCredential } from '@cv/convex/model/credentials'
import { getActiveSegmentRow } from '@cv/convex/model/messageContents'
import { modelReference } from '@cv/core/model-reference'
import { v } from 'convex/values'

const modelId = 'perf-stream-model'

export const _provider = internalMutation({
  args: { ownerId: v.id('users'), baseURL: v.string() },
  handler: async (ctx, { ownerId, baseURL }) => {
    const activeAgentId = await ctx.db.insert('agents', {
      ownerId,
      name: 'Streaming benchmark agent',
      tools: [],
    })
    const providerId = await ctx.db.insert('modelProviders', {
      ownerId,
      key: 'streaming-perf',
      order: 0,
      enabled: true,
      baseURL,
      models: [{ id: modelId, contextWindow: 8192 }],
    })
    await setCredential(ctx, ownerId, 'provider', providerId, 'synthetic-key')
    return { activeAgentId, model: modelReference(providerId, modelId) }
  },
})

export const _session = internalMutation({
  args: {
    ownerId: v.id('users'),
    activeAgentId: v.id('agents'),
    model: v.string(),
    title: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { ownerId, activeAgentId, model, title = 'Active streaming benchmark' },
  ) => {
    const lastMessageAt = Date.now()
    const sessionId = await ctx.db.insert('sessions', {
      ownerId,
      title,
      lastMessageAt,
      activeAgentId,
      model: { id: model },
    })
    await ctx.db.insert('userSessions', {
      sessionId,
      userId: ownerId,
      role: 'owner',
      title,
      lastMessageAt,
      groupKey: 'ungrouped',
    })
    await ctx.db.insert('sessionAgents', {
      sessionId,
      agentId: activeAgentId,
      addedBy: ownerId,
    })
    return sessionId
  },
})

export const stopText = authQuery({
  args: { sessionId: v.id('sessions') },
  handler: async (ctx, { sessionId }) => {
    const session = await ctx.db.get(sessionId)
    if (session?.ownerId !== ctx.userId) error('Session unavailable')
    const message = await ctx.db
      .query('messages')
      .withIndex('by_sessionId', (q) => q.eq('sessionId', sessionId))
      .order('desc')
      .filter((q) => q.eq(q.field('role'), 'assistant'))
      .first()
    if (!message) return ''
    const row = await getActiveSegmentRow(ctx, message)
    return (row?.parts ?? [])
      .flatMap((part) => (part.type === 'text' ? [part.text] : []))
      .join('')
  },
})
