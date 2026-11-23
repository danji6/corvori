import type { Doc } from '../../_generated/dataModel'
import type { QueryCtx } from '../../_generated/server'
import { type MessageWithParts, listSelectedSegments } from '../messageContents'
import { withoutUnevaluatedText } from '../messages'

/** Keeps unrendered historical or in-flight text out of model input. */
export async function modelSegmentParts(
  ctx: QueryCtx,
  row: Doc<'messageContents'>,
) {
  const safe = withoutUnevaluatedText(row.parts)
  if (safe.length === row.parts.length || !row.promptEvaluationId) return safe
  const evaluation = await ctx.db.get(row.promptEvaluationId)
  const target = evaluation?.target
  // Older starter and reminder results were stored without a part marker.
  if (
    evaluation?.state === 'complete' &&
    target?.kind === 'message' &&
    'promptId' in target
  ) {
    return row.parts
  }
  return safe
}

export async function withModelParts(
  ctx: QueryCtx,
  message: Doc<'messages'>,
): Promise<MessageWithParts> {
  const segments = await listSelectedSegments(ctx, message)
  const parts = await Promise.all(
    segments.map((row) => modelSegmentParts(ctx, row)),
  )
  return { ...message, parts: parts.flat() }
}
