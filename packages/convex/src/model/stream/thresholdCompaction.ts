import { usableContextWindow } from '@cv/core/discovered-model'
import { messagePosition } from '@cv/core/message-position'
import { hasPendingQuestions } from '@cv/core/utils/ask'
import { hasPendingToolApprovals } from '@cv/core/utils/tool-parts'
import { hasPendingYield } from '@cv/core/utils/yield'

import type { Doc, Id } from '../../_generated/dataModel'
import type { MutationCtx } from '../../_generated/server'
import { error } from '../../errors'
import { hasUnsettledTaskParts } from '../../lib/subagent'
import type {
  RunningStream,
  SessionMode,
  StreamExecutionArgs,
  ThresholdCompactionArgs,
} from '../../types'
import { effectiveAgentSelection } from '../agent/modelOverride'
import { insertCommandChip } from '../chat/commandChips'
import { senderIdentity } from '../chat/identities'
import { scheduledCompactForStream } from '../chat/scheduling'
import { pending as pendingMcp } from '../mcpOperations'
import {
  finalizeTurn,
  getProcessingSegmentRow,
  insertMessage,
} from '../messageContents'
import { finalizeMessageParts, scheduleMessageEval } from '../messages'
import { getSavedModel } from '../provider/providers'
import { consume as consumeEvent } from '../scheduledEvents'
import { patchState } from '../session/state'
import { ownsExecution, scheduleStream } from './execution'
import {
  canCheckCompactionThreshold,
  resolveHistoryBoundary,
} from './historyBoundary'
import { isApprovedToolAwaitingExecution } from './lifecycleProgress'
import { honorSoftStop } from './stop'

/** Returns true when the action must exit before sending its prepared request. */
export async function _compactAtThreshold(
  ctx: MutationCtx,
  args: ThresholdCompactionArgs,
) {
  const stream = await ctx.db.get(args.streamId)
  if (!ownsExecution(stream, args)) return true
  if (await honorSoftStop(ctx, stream)) return true
  const command = stream.command
  if (command.kind !== 'invoke' || !canCheckCompactionThreshold(command)) {
    return false
  }

  if (!(await matchesPreparedModel(ctx, stream, args))) {
    await scheduleStream(ctx, stream._id)
    return true
  }

  const snapshot = await compactionSnapshot(ctx, stream, args)
  if (!snapshot) return false

  if (args.environment)
    await patchState(ctx, stream.sessionId, { environment: args.environment })
  await startThresholdCompaction(ctx, stream, snapshot, command.mode)

  return true
}

async function matchesPreparedModel(
  ctx: MutationCtx,
  stream: RunningStream,
  { modelId, contextWindow }: ThresholdCompactionArgs,
) {
  const [session, agent] = await Promise.all([
    ctx.db.get(stream.sessionId),
    ctx.db.get(stream.agentId),
  ])
  if (!agent || !session) return false
  if (effectiveAgentSelection(session, agent.modelOverride).modelId !== modelId)
    return false

  const saved = await getSavedModel(ctx, agent.ownerId, modelId)
  return (
    saved?.model.available !== false &&
    !saved?.model.trimContext &&
    usableContextWindow(saved?.model.contextWindow) === contextWindow
  )
}

function hasUnsettledWork(parts: unknown[]) {
  return (
    parts.some(isApprovedToolAwaitingExecution) ||
    hasPendingToolApprovals(parts) ||
    hasPendingQuestions(parts) ||
    hasPendingYield(parts) ||
    hasUnsettledTaskParts(parts)
  )
}

async function compactionSnapshot(
  ctx: MutationCtx,
  stream: RunningStream,
  execution: StreamExecutionArgs,
) {
  const [message, row] = await Promise.all([
    ctx.db.get(stream.state.processingMessageId),
    getProcessingSegmentRow(ctx, stream),
  ])
  if (!message || !row || hasUnsettledWork(row.parts)) return null
  if ((await pendingMcp(ctx, execution)).length) return null

  const hasOutput = row.parts.length > 0 || row.segmentIndex > 0
  const boundary = await findCompactionBoundary(ctx, stream, message, hasOutput)
  return boundary ? { message, row, hasOutput, boundary } : null
}

async function findCompactionBoundary(
  ctx: MutationCtx,
  stream: RunningStream,
  output: Doc<'messages'>,
  hasOutput: boolean,
) {
  const { floor } = await resolveHistoryBoundary(ctx, stream)
  if (hasOutput && output._creationTime > floor) {
    const inputBoundary = stream.contextBoundaryMessageId
    if (
      inputBoundary &&
      (stream.contextBoundaryCreationTime ?? 0) > output._creationTime
    ) {
      return (await ctx.db.get(inputBoundary)) ?? output
    }
    return output
  }

  const upper = stream.contextBoundaryCreationTime
  if (upper === undefined || upper <= floor) return null

  return ctx.db
    .query('messages')
    .withIndex('by_sessionId_status_contextEligible', (q) =>
      q
        .eq('sessionId', stream.sessionId)
        .eq('status', 'done')
        .eq('contextEligible', true)
        .gt('_creationTime', floor)
        .lte('_creationTime', upper),
    )
    .filter((q) =>
      q.and(
        q.eq(q.field('role'), 'assistant'),
        q.neq(q.field('type'), 'summary'),
      ),
    )
    .order('desc')
    .first()
}

type CompactionSnapshot = NonNullable<
  Awaited<ReturnType<typeof compactionSnapshot>>
>

async function startThresholdCompaction(
  ctx: MutationCtx,
  stream: RunningStream,
  snapshot: CompactionSnapshot,
  mode: SessionMode | undefined,
) {
  const { boundary } = snapshot
  const output = await prepareSummaryOutput(ctx, snapshot, stream.invokedBy)
  await announceThresholdCompaction(ctx, stream, output.processingMessageId)

  await ctx.db.patch(stream._id, {
    command: {
      kind: 'compact',
      autoCompact: true,
      preserveContextBoundary: true,
      thresholdResume: { mode, omitActiveMedia: stream.omitActiveMedia },
    },
    state: { phase: 'reserved', ...output },
    contextBoundaryMessageId: boundary._id,
    contextBoundaryCreationTime: boundary._creationTime,
    providerContinuity: undefined,
  })
  await ctx.db.patch(output.processingMessageId, {
    type: 'summary',
    summaryBoundaryCreationTime: boundary._creationTime,
  })
  await scheduleStream(ctx, stream._id, { resetAttempt: true })
}

async function announceThresholdCompaction(
  ctx: MutationCtx,
  stream: RunningStream,
  summaryMessageId: Id<'messages'>,
) {
  const event = await scheduledCompactForStream(ctx, stream)
  if (event) {
    await consumeEvent(ctx, event)
    return
  }

  const summary = await ctx.db.get(summaryMessageId)
  if (!summary) error('Compaction summary missing', 500)
  await insertCommandChip(
    ctx,
    stream.sessionId,
    stream.invokedBy,
    { name: 'autoCompact', source: 'contextWindow' },
    'ran',
    summary,
  )
}

async function prepareSummaryOutput(
  ctx: MutationCtx,
  { message, row, hasOutput }: CompactionSnapshot,
  invokedBy: Id<'users'>,
) {
  if (!hasOutput) {
    await detachContextNotes(ctx, message)
    return { processingMessageId: message._id, processingContentId: row._id }
  }

  const parts = finalizeMessageParts(row.parts)
  await finalizeTurn(ctx, {
    message,
    row,
    parts,
    metadata: row.metadata,
  })
  await scheduleMessageEval(ctx, {
    messageId: message._id,
    invokerId: invokedBy,
    parts,
    version: row.version,
    segmentIndex: row.segmentIndex,
  })
  const output = await insertMessage(
    ctx,
    {
      sessionId: message.sessionId,
      sender: message.sender,
      role: 'assistant',
      ...senderIdentity(message),
      status: 'processing',
    },
    [],
  )
  return {
    processingMessageId: output.messageId,
    processingContentId: output.contentId,
  }
}

/** Keeps notes prepared for the reply outside the summary's frozen input. */
async function detachContextNotes(ctx: MutationCtx, message: Doc<'messages'>) {
  const notes = await ctx.db
    .query('messages')
    .withIndex('by_sessionId_contextAnchor', (q) =>
      q
        .eq('sessionId', message.sessionId)
        .eq('extra.anchorMessageId', message._id),
    )
    .collect()
  for (const note of notes) {
    if (note.extra && 'anchorMessageId' in note.extra) {
      await ctx.db.patch(note._id, {
        position: messagePosition(note),
        extra: {
          ...note.extra,
          anchorMessageId: undefined,
          anchorPartCount: undefined,
        },
      })
    }
  }
}

/** Re-enters the same invocation after the summary has been committed. */
export async function resumeAfterThresholdCompaction(
  ctx: MutationCtx,
  stream: Doc<'streams'>,
) {
  if (stream.command.kind !== 'compact' || !stream.command.thresholdResume)
    return
  await ctx.db.patch(stream._id, {
    command: {
      kind: 'invoke',
      mode: stream.command.thresholdResume.mode,
      skipThresholdCompaction: true,
    },
    state: { phase: 'reserved' },
    omitActiveMedia: stream.command.thresholdResume.omitActiveMedia,
    providerContinuity: undefined,
    skillCatalogSource: undefined,
    skillAvailability: undefined,
    skillContextPrepared: undefined,
    skillToolkitFingerprint: undefined,
    skillContextMessageId: undefined,
    workspaceContextPrepared: undefined,
    workspaceContextMessageId: undefined,
    mcpContextFingerprint: undefined,
    mcpContextMessageId: undefined,
  })
  await scheduleStream(ctx, stream._id, { resetAttempt: true })
}
