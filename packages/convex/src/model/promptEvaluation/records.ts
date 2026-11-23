import { internal } from '../../_generated/api'
import type { Doc, Id } from '../../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../../_generated/server'
import { replaceEvaluationPlaceholders, searchTextFromParts } from '../messages'
import { advanceCompletedHistoryRevision } from '../session/state'

export function listPending(ctx: QueryCtx, sessionId: Id<'sessions'>) {
  return ctx.db
    .query('promptEvaluations')
    .withIndex('by_sessionId_state_finishedAt', (q) =>
      q.eq('sessionId', sessionId).eq('state', 'pending'),
    )
    .collect()
}

export function listItems(
  ctx: QueryCtx,
  evaluationId: Id<'promptEvaluations'>,
) {
  return ctx.db
    .query('promptEvaluationItems')
    .withIndex('by_evaluationId_position', (q) =>
      q.eq('evaluationId', evaluationId),
    )
    .collect()
}

export async function cancelEvaluation(
  ctx: MutationCtx,
  evaluation: Doc<'promptEvaluations'>,
) {
  if (evaluation.state !== 'pending') return

  await ctx.db.patch(evaluation._id, {
    state: 'cancelled',
    inputParts: undefined,
    error: 'Prompt evaluation stopped',
  })

  if (evaluation.target.kind === 'message') {
    const { contentId, messageId } = evaluation.target
    const [row, message] = await Promise.all([
      ctx.db.get(contentId),
      ctx.db.get(messageId),
    ])

    if (row?.promptEvaluationId === evaluation._id) {
      const parts =
        'promptId' in evaluation.target
          ? [{ type: 'text', text: 'Prompt evaluation stopped' }]
          : replaceEvaluationPlaceholders(
              row.parts,
              'Prompt evaluation stopped',
            )
      await ctx.db.patch(row._id, {
        parts,
        searchText: message?.hidden ? undefined : searchTextFromParts(parts),
      })
      await advanceCompletedHistoryRevision(ctx, row.sessionId)
    }
  }
  if (evaluation.bootId) {
    await ctx.scheduler.runAfter(
      0,
      internal.actions.messages._cancelPromptEvaluation,
      {
        id: evaluation._id,
        bootId: evaluation.bootId,
      },
    )
  }
}

export async function releaseEvaluation(
  ctx: MutationCtx,
  id?: Id<'promptEvaluations'>,
) {
  if (!id) return
  const evaluation = await ctx.db.get(id)
  if (!evaluation) return
  await cancelEvaluation(ctx, evaluation)
  for (const item of await listItems(ctx, id)) await ctx.db.delete(item._id)
  await ctx.db.delete(id)
}

export async function cancelStreamEvaluations(
  ctx: MutationCtx,
  streamId: Id<'streams'>,
) {
  const rows = await ctx.db
    .query('promptEvaluations')
    .withIndex('by_streamId', (q) => q.eq('streamId', streamId))
    .collect()
  for (const row of rows) await cancelEvaluation(ctx, row)
}
