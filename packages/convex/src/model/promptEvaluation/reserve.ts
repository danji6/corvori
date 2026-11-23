import { internal } from '../../_generated/api'
import type { Doc, Id } from '../../_generated/dataModel'
import type { MutationCtx } from '../../_generated/server'
import { minRole } from '../../lib/roles'
import type { StreamExecutionArgs } from '../../validators/streams'
import { getProcessingSegmentRow, getSegmentRow } from '../messageContents'
import {
  isUnevaluatedTextPart,
  partsHaveScript,
  searchTextFromParts,
} from '../messages'
import type { PromptItem } from '../prompt/prompts'
import { _save, findCache, removeCacheRow } from '../session/cache'
import { ownsExecution } from '../stream/execution'
import { replaysProcessingMessage } from '../stream/historyBoundary'
import { releaseEvaluation } from './records'

type StreamTarget = 'snapshot' | 'operation'

type StreamReservation = StreamExecutionArgs & {
  kind: StreamTarget
  items: PromptItem[]
  cacheId?: Id<'sessionCache'>
}

export async function reserveStreamEvaluation(
  ctx: MutationCtx,
  args: StreamReservation,
) {
  const stream = await ctx.db.get(args.streamId)
  if (!ownsExecution(stream, args)) return null

  const { sessionId, agentId, invokedBy } = stream
  const [agent, invoker] = await Promise.all([
    ctx.db.get(agentId),
    ctx.db.get(invokedBy),
  ])
  if (!agent || !invoker) return null

  const data = { sessionId, agentId, invokedBy, ownerId: agent.ownerId }

  if (args.kind === 'operation') {
    if (stream.promptEvaluationId) return stream.promptEvaluationId
    const id = await insertBatch(
      ctx,
      data,
      args.items,
      {
        kind: 'operation',
        streamId: stream._id,
      },
      stream._id,
    )
    await ctx.db.patch(stream._id, { promptEvaluationId: id })
    return id
  }

  const access = minRole(invoker.role, 'admin')
  const cache = await findCache(ctx, sessionId, agentId)
  const previous = cache?.promptEvaluationId && (await ctx.db.get(cache.promptEvaluationId)) // prettier-ignore

  if (previous && (cache.filesystemAccess ?? false) === access)
    if (previous.state !== 'cancelled') return previous._id
  // An invalidation between the read and reserve must not publish stale input.
  if (args.cacheId && args.cacheId !== cache?._id) return null
  if (cache) await removeCacheRow(ctx, cache)

  const cacheId = await _save(ctx, {
    sessionId,
    agentId,
    filesystemAccess: access,
  })

  const id = await insertBatch(
    ctx,
    data,
    args.items,
    {
      kind: 'snapshot',
      cacheId,
    },
    stream._id,
  )
  await ctx.db.patch(cacheId, { promptEvaluationId: id })

  return id
}

type EvaluationIdentity = Pick<
  Doc<'promptEvaluations'>,
  'sessionId' | 'agentId' | 'invokedBy' | 'ownerId'
>

async function insertBatch(
  ctx: MutationCtx,
  identity: EvaluationIdentity,
  items: PromptItem[],
  target: Doc<'promptEvaluations'>['target'],
  streamId: Id<'streams'>,
) {
  const id = await ctx.db.insert('promptEvaluations', {
    ...identity,
    target,
    state: 'pending',
    startedAt: Date.now(),
    streamId,
  })
  for (const [position, item] of items.entries()) {
    await ctx.db.insert('promptEvaluationItems', {
      evaluationId: id,
      position,
      item,
    })
  }
  return id
}

type MessageReservation = {
  sessionId: Id<'sessions'>
  invokedBy: Id<'users'>
  messageId: Id<'messages'>
  contentId: Id<'messageContents'>
  hidden?: boolean
  parts: unknown[]
} & (
  | {
      agent: Pick<Doc<'agents'>, '_id' | 'ownerId'>
      origin: 'starter' | 'reminder'
      promptId: string
    }
  | { agentId?: Id<'agents'>; origin: 'userSend' | 'transcript' }
)

export async function reserveMessageEvaluation(
  ctx: MutationCtx,
  input: MessageReservation,
) {
  if (!partsHaveScript(input.parts)) return

  const { messageId, contentId, invokedBy, sessionId } = input
  const configured = 'agent' in input
  const target = { kind: 'message' as const, messageId, contentId }

  const id = await ctx.db.insert('promptEvaluations', {
    sessionId,
    agentId: configured ? input.agent._id : input.agentId,
    ownerId: configured ? input.agent.ownerId : invokedBy,
    invokedBy,
    target: configured
      ? { ...target, origin: input.origin, promptId: input.promptId }
      : { ...target, origin: input.origin },
    state: 'pending',
    startedAt: Date.now(),
    inputParts: input.parts,
  })

  const parts = input.parts.map((part) =>
    isUnevaluatedTextPart(part)
      ? { type: 'text', text: 'Evaluating prompt…', evaluationPending: true }
      : part,
  )

  await ctx.db.patch(contentId, {
    promptEvaluationId: id,
    parts,
    searchText: input.hidden ? undefined : searchTextFromParts(parts),
  })

  await ctx.scheduler.runAfter(
    0,
    internal.actions.messages._runPromptEvaluation,
    { id },
  )
}

type SegmentReservation = {
  messageId: Id<'messages'>
  invokerId: Id<'users'>
  version: number
  segmentIndex: number
  parts: unknown[]
  origin?: 'userSend'
}

export async function reserveSegmentEvaluation(
  ctx: MutationCtx,
  input: SegmentReservation,
) {
  if (!partsHaveScript(input.parts)) return

  const { messageId, version, segmentIndex, invokerId, origin } = input
  const [message, row] = await Promise.all([
    ctx.db.get(messageId),
    getSegmentRow(ctx, messageId, version, segmentIndex),
  ])
  if (!message || !row) return

  const session = await ctx.db.get(message.sessionId)
  if (!session) return

  await reserveStoredSegment(
    ctx,
    message,
    row,
    invokerId,
    session.activeAgentId,
    origin,
  )
}

/** Captures the finished portion of a live reply before a provider continuation. */
export async function reserveLiveEvaluation(
  ctx: MutationCtx,
  execution: StreamExecutionArgs,
) {
  const stream = await ctx.db.get(execution.streamId)

  if (!ownsExecution(stream, execution) || !stream.state.processingMessageId)
    return
  if (!replaysProcessingMessage(stream.command)) {
    return
  }

  const [message, row] = await Promise.all([
    ctx.db.get(stream.state.processingMessageId),
    getProcessingSegmentRow(ctx, stream),
  ])
  if (!message || !row) return

  await reserveStoredSegment(
    ctx,
    message,
    row,
    stream.invokedBy,
    stream.agentId,
  )
}

async function reserveStoredSegment(
  ctx: MutationCtx,
  message: Doc<'messages'>,
  row: Doc<'messageContents'>,
  invokedBy: Id<'users'>,
  agentId?: Id<'agents'>,
  origin: 'userSend' | 'transcript' = 'transcript',
) {
  if (!partsHaveScript(row.parts)) return
  await releaseEvaluation(ctx, row.promptEvaluationId)
  await reserveMessageEvaluation(ctx, {
    sessionId: message.sessionId,
    messageId: message._id,
    contentId: row._id,
    hidden: message.hidden,
    parts: row.parts,
    invokedBy,
    agentId,
    origin,
  })
}
