import { internal } from '../../_generated/api'
import type { Doc, Id } from '../../_generated/dataModel'
import type { MutationCtx } from '../../_generated/server'
import { error } from '../../errors'
import type { StreamExecutionArgs, StreamState } from '../../validators/streams'
import { latestAttachmentSend } from '../chat/attachmentSendRecords'
import { isHistoricalTurn } from './historyBoundary'
import { STREAM_LEASE_MS } from './lease'
import type { RunningStream } from './types'

/** Identifies the action that owns this stream execution. */
export function matchesExecution(
  stream: Doc<'streams'> | null,
  args: StreamExecutionArgs,
): stream is Doc<'streams'> {
  return stream?.generation === args.generation
}

export function ownsExecution(
  stream: Doc<'streams'> | null,
  args: StreamExecutionArgs,
): stream is RunningStream {
  if (!matchesExecution(stream, args)) return false
  return stream.state.phase === 'streaming'
}

/** Cancels only work still owned by a scheduled phase. */
export async function cancelScheduledExecution(
  ctx: MutationCtx,
  stream: Doc<'streams'>,
) {
  const { state } = stream
  if (state.phase === 'pending' || state.phase === 'retrying') {
    await ctx.scheduler.cancel(state.jobId)
  }
  if (state.phase === 'awaiting_input' && state.yield?.jobId) {
    await ctx.scheduler.cancel(state.yield.jobId)
  }
}

type StreamOutput = {
  processingMessageId: Id<'messages'>
  processingContentId?: Id<'messageContents'>
}

type StreamBoundary = {
  contextBoundaryMessageId?: Id<'messages'>
  contextBoundaryCreationTime?: number
}

type ScheduleOptions =
  | {
      kind?: 'pending'
      delayMs?: number
      fireAt?: number
      resetAttempt?: boolean
    }
  | {
      kind: 'retrying'
      retryAt: number
      retryError: string
    }

export function startsFreshResponse(stream: Doc<'streams'>) {
  if (stream.state.processingMessageId || isHistoricalTurn(stream.command)) {
    return false
  }
  return (
    stream.command.kind !== 'compact' || !stream.command.preserveContextBoundary
  )
}

/** Parks a fresh turn until the last live send reservation is released. */
export async function deferForAttachments(
  ctx: MutationCtx,
  stream: Doc<'streams'>,
  generation: number,
  fireAt?: number,
) {
  if (!startsFreshResponse(stream)) return false
  const pending = await latestAttachmentSend(ctx, stream.sessionId)
  if (!pending) return false

  await ctx.db.patch(stream._id, {
    generation,
    state: { phase: 'awaiting_attachments', fireAt },
    leaseExpiresAt: pending.expiresAt + STREAM_LEASE_MS,
  })

  return true
}

/** Replaces scheduled work atomically and invalidates the previous execution. */
export async function scheduleStream(
  ctx: MutationCtx,
  streamId: Id<'streams'>,
  options: ScheduleOptions = {},
) {
  const stream = await ctx.db.get(streamId)
  if (!stream) error('Cannot schedule a missing stream', 409)
  if (stream.state.phase === 'stopping')
    error('Cannot schedule a stopping stream', 409)

  await cancelScheduledExecution(ctx, stream)

  const generation = stream.generation + 1
  if (options.kind !== 'retrying') {
    const deferred = await deferForAttachments(
      ctx,
      stream,
      generation,
      options.fireAt,
    )
    if (deferred) return
  }
  const args = { streamId, generation }
  const next =
    options.kind === 'retrying'
      ? await scheduleRetryState(ctx, stream, args, options)
      : await schedulePendingState(ctx, stream, args, options)

  await ctx.db.patch(streamId, { generation, ...next })
}

export async function wakeAttachmentTurn(
  ctx: MutationCtx,
  sessionId: Id<'sessions'>,
) {
  const stream = await ctx.db
    .query('streams')
    .withIndex('by_sessionId', (q) => q.eq('sessionId', sessionId))
    .first()
  if (stream?.state.phase !== 'awaiting_attachments') return
  if (await latestAttachmentSend(ctx, sessionId)) return

  const { fireAt } = stream.state
  await scheduleStream(ctx, stream._id, {
    fireAt,
    delayMs: fireAt === undefined ? 0 : Math.max(0, fireAt - Date.now()),
  })
}

/** Schedules a fresh action without consuming another provider retry attempt. */
async function schedulePendingState(
  ctx: MutationCtx,
  stream: Doc<'streams'>,
  args: StreamExecutionArgs,
  options: Exclude<ScheduleOptions, { kind: 'retrying' }>,
) {
  const jobId = await ctx.scheduler.runAfter(
    options.delayMs ?? 0,
    internal.actions.streams._stream,
    args,
  )
  const state: StreamState = {
    phase: 'pending',
    jobId,
    fireAt: options.fireAt,
    processingMessageId: stream.state.processingMessageId,
    processingContentId: stream.state.processingContentId,
  }
  return {
    state,
    attempt: options.resetAttempt ? 0 : stream.attempt,
    leaseExpiresAt: Date.now() + STREAM_LEASE_MS,
  }
}

/** Schedules a provider retry with its error and a lease covering the delay. */
async function scheduleRetryState(
  ctx: MutationCtx,
  stream: Doc<'streams'>,
  args: StreamExecutionArgs,
  options: Extract<ScheduleOptions, { kind: 'retrying' }>,
) {
  const processingMessageId = stream.state.processingMessageId
  if (!processingMessageId) error('Cannot retry an unclaimed stream', 409)
  const jobId = await ctx.scheduler.runAt(
    options.retryAt,
    internal.actions.streams._stream,
    args,
  )
  const state: StreamState = {
    phase: 'retrying',
    jobId,
    retryAt: options.retryAt,
    retryError: options.retryError,
    processingMessageId,
    processingContentId: stream.state.processingContentId,
  }
  return {
    state,
    attempt: stream.attempt + 1,
    leaseExpiresAt: options.retryAt + STREAM_LEASE_MS,
  }
}

/** Claims the current output and drops all scheduled-phase data. */
export async function startExecution(
  ctx: MutationCtx,
  stream: Doc<'streams'>,
  output: StreamOutput,
  boundary: StreamBoundary,
): Promise<RunningStream> {
  const state = { phase: 'streaming' as const, ...output }
  const leaseExpiresAt = Date.now() + STREAM_LEASE_MS
  await ctx.db.patch(stream._id, { state, ...boundary, leaseExpiresAt })
  return { ...stream, state, ...boundary, leaseExpiresAt }
}
