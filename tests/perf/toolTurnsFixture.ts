import type { Id } from '@cv/convex/_generated/dataModel'
import {
  type MutationCtx,
  internalMutation,
} from '@cv/convex/_generated/server'
import { set as setCredential } from '@cv/convex/model/credentials'
import {
  insertMessage,
  patchSegmentParts,
} from '@cv/convex/model/messageContents'
import { modelReference } from '@cv/core/model-reference'
import { v } from 'convex/values'

const title = 'Tool turn performance'
const modelId = 'gpt-5-mini'

export const _owner = internalMutation({
  args: {},
  handler: async (ctx) => {
    const ownerId = await ctx.db.insert('users', {
      role: 'admin',
      subject: 'perf-tool-turns',
    })
    const agentId = await ctx.db.insert('agents', {
      ownerId,
      name: 'Perf agent',
      tools: ['write_todo'],
    })
    const providerId = await ctx.db.insert('modelProviders', {
      ownerId,
      key: 'openai',
      order: 0,
      enabled: true,
      baseURL: 'http://127.0.0.1:1',
      models: [{ id: modelId, contextWindow: 8192, trimContext: true }],
    })
    await setCredential(ctx, ownerId, 'provider', providerId, 'synthetic-key')
    return { ownerId, agentId, model: modelReference(providerId, modelId) }
  },
})

async function seedHistory(
  ctx: MutationCtx,
  sessionId: Id<'sessions'>,
  ownerId: Id<'users'>,
  agentId: Id<'agents'>,
  historyMessages: number,
) {
  for (let index = 0; index < historyMessages; index++) {
    const user = index % 2 === 0
    await insertMessage(
      ctx,
      {
        sessionId,
        role: user ? 'user' : 'assistant',
        sender: user
          ? { type: 'user', id: ownerId }
          : { type: 'agent', id: agentId },
        status: 'done',
      },
      [
        {
          type: 'text',
          text: `History message ${index}. ${'word '.repeat(200)}`,
        },
      ],
    )
  }
}

export const _turn = internalMutation({
  args: {
    ownerId: v.id('users'),
    agentId: v.id('agents'),
    model: v.string(),
    historyMessages: v.number(),
  },
  handler: async (ctx, { ownerId, agentId, model, historyMessages }) => {
    const sessionId = await ctx.db.insert('sessions', {
      ownerId,
      title,
      activeAgentId: agentId,
      model: { id: model },
    })
    await ctx.db.insert('userSessions', {
      sessionId,
      userId: ownerId,
      role: 'owner',
      title,
      groupKey: 'ungrouped',
    })
    await seedHistory(ctx, sessionId, ownerId, agentId, historyMessages)
    const latest = await insertMessage(
      ctx,
      {
        sessionId,
        role: 'user',
        sender: { type: 'user', id: ownerId },
        status: 'done',
      },
      [{ type: 'text', text: 'Current benchmark turn input.' }],
    )
    const boundary = await ctx.db.get(latest.messageId)
    if (!boundary) throw new Error('Missing history boundary')
    const output = await insertMessage(
      ctx,
      {
        sessionId,
        role: 'assistant',
        sender: { type: 'agent', id: agentId },
        status: 'processing',
      },
      [],
    )
    const generation = 1
    const streamId = await ctx.db.insert('streams', {
      sessionId,
      agentId,
      invokedBy: ownerId,
      command: { kind: 'invoke' },
      state: {
        phase: 'streaming',
        processingMessageId: output.messageId,
        processingContentId: output.contentId,
      },
      attempt: 0,
      generation,
      leaseExpiresAt: Date.now() + 60_000,
      contextBoundaryMessageId: latest.messageId,
      contextBoundaryCreationTime: boundary._creationTime,
    })
    return { streamId, generation }
  },
})

export const _appendResult = internalMutation({
  args: { streamId: v.id('streams'), index: v.number() },
  handler: async (ctx, { streamId, index }) => {
    const stream = await ctx.db.get(streamId)
    const contentId = stream?.state.processingContentId
    const row = contentId && (await ctx.db.get(contentId))
    if (!row) throw new Error('Missing processing content')
    await patchSegmentParts(ctx, row.messageId, row, [
      ...row.parts,
      {
        type: 'tool-write_todo',
        state: 'output-available',
        toolCallId: `perf-call-${index}`,
        input: { todos: [`Task ${index}`] },
        output: `Saved todo ${index}. ${'result '.repeat(80)}`,
      },
    ])
  },
})
