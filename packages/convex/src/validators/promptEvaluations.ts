import { v } from 'convex/values'

import { promptItemValidator } from './prompts'

export const promptEvaluationTarget = v.union(
  v.object({ kind: v.literal('snapshot'), cacheId: v.id('sessionCache') }),
  v.object({ kind: v.literal('operation'), streamId: v.id('streams') }),
  v.object({
    kind: v.literal('message'),
    contentId: v.id('messageContents'),
    messageId: v.id('messages'),
    origin: v.union(v.literal('starter'), v.literal('reminder')),
    promptId: v.string(),
  }),
  v.object({
    kind: v.literal('message'),
    contentId: v.id('messageContents'),
    messageId: v.id('messages'),
    origin: v.union(v.literal('userSend'), v.literal('transcript')),
  }),
)

export const promptEvaluationSchema = v.object({
  sessionId: v.id('sessions'),
  agentId: v.optional(v.id('agents')),
  invokedBy: v.id('users'),
  ownerId: v.id('users'),
  target: promptEvaluationTarget,
  state: v.union(
    v.literal('pending'),
    v.literal('complete'),
    v.literal('failed'),
    v.literal('cancelled'),
  ),
  startedAt: v.number(),
  finishedAt: v.optional(v.number()),
  bootId: v.optional(v.string()),
  streamId: v.optional(v.id('streams')),
  inputParts: v.optional(v.array(v.any())),
  error: v.optional(v.string()),
})

export const promptEvaluationItemSchema = v.object({
  evaluationId: v.id('promptEvaluations'),
  position: v.number(),
  item: promptItemValidator,
})
