'use node'

import { v } from 'convex/values'

import { internalAction } from '../_generated/server'

export const _runPromptEvaluation = internalAction({
  args: { id: v.id('promptEvaluations') },
  handler: async (ctx, { id }) => {
    const { runStandaloneEvaluation } =
      await import('../model/promptEvaluation/runner')
    await runStandaloneEvaluation(ctx, id)
  },
})

export const _cancelPromptEvaluation = internalAction({
  args: { id: v.id('promptEvaluations'), bootId: v.string() },
  handler: async (_ctx, args) => {
    const { cancelSidecarEvaluation } =
      await import('../model/promptEvaluation/runner')
    await cancelSidecarEvaluation(args)
  },
})
