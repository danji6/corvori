import { v } from 'convex/values'

import { internalMutation, internalQuery } from './_generated/server'
import { authQuery } from './functions'
import { listPending } from './model/promptEvaluation/records'
import {
  reserveLiveEvaluation,
  reserveStreamEvaluation,
} from './model/promptEvaluation/reserve'
import * as State from './model/promptEvaluation/state'
import { requireMember } from './model/session/memberships'
import { promptItemValidator } from './validators/prompts'
import { streamExecutionArgsValidator } from './validators/streams'

const evaluationId = { id: v.id('promptEvaluations') }

export const active = authQuery({
  args: { sessionId: v.id('sessions') },
  handler: async (ctx, { sessionId }) => {
    await requireMember(ctx, sessionId, ctx.userId)
    const pending = await listPending(ctx, sessionId)
    return pending.length
      ? Math.min(...pending.map((row) => row.startedAt))
      : null
  },
})

export const _reserve = internalMutation({
  args: {
    ...streamExecutionArgsValidator.fields,
    kind: v.union(v.literal('snapshot'), v.literal('operation')),
    items: v.array(promptItemValidator),
    cacheId: v.optional(v.id('sessionCache')),
  },
  handler: reserveStreamEvaluation,
})

export const _get = internalQuery({
  args: evaluationId,
  handler: State.readState,
})

export const _reserveLive = internalMutation({
  args: streamExecutionArgsValidator.fields,
  handler: reserveLiveEvaluation,
})

export const _input = internalQuery({
  args: evaluationId,
  handler: State.readInput,
})

export const _result = internalQuery({
  args: evaluationId,
  handler: State.readResult,
})

export const _pendingHistory = internalQuery({
  args: streamExecutionArgsValidator.fields,
  handler: State.pendingHistory,
})

export const _pin = internalMutation({
  args: { ...evaluationId, bootId: v.string() },
  handler: State.pinInstance,
})

export const _stage = internalMutation({
  args: {
    ...evaluationId,
    itemId: v.id('promptEvaluationItems'),
    content: v.string(),
  },
  handler: State.stageItem,
})

export const _finish = internalMutation({
  args: {
    ...evaluationId,
    parts: v.optional(v.array(v.any())),
    writes: v.optional(v.record(v.string(), v.any())),
    error: v.optional(v.string()),
  },
  handler: State.finishEvaluation,
})
