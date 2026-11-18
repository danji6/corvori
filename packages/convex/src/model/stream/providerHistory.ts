import { orderContextNotes } from '@cv/core/context-notes'

import type { Doc, Id } from '../../_generated/dataModel'
import type { QueryCtx } from '../../_generated/server'
import type {
  ProviderHistorySnapshotArgs,
  StreamExecutionArgs,
} from '../../types'
import {
  type MessageWithParts,
  withParts,
  withPartsMany,
} from '../messageContents'
import { getState } from '../session/state'
import { ownsExecution } from './execution'
import { resolveHistoryBoundary } from './historyBoundary'

type Boundary = Awaited<ReturnType<typeof resolveHistoryBoundary>>

export async function _getProviderHistory(
  ctx: QueryCtx,
  execution: StreamExecutionArgs,
) {
  const stream = await ctx.db.get(execution.streamId)
  if (!ownsExecution(stream, execution)) return []

  const boundary = await resolveHistoryBoundary(ctx, stream)
  const [completed, live] = await Promise.all([
    readCompleted(ctx, stream, boundary),
    readLive(ctx, stream, boundary.floor),
  ])
  return assembleProviderHistory(completed, live)
}

export async function _getProviderHistorySnapshot(
  ctx: QueryCtx,
  { knownHistory, ...execution }: ProviderHistorySnapshotArgs,
) {
  const stream = await ctx.db.get(execution.streamId)
  if (!ownsExecution(stream, execution)) return null

  const [boundary, state] = await Promise.all([
    resolveHistoryBoundary(ctx, stream),
    getState(ctx, stream.sessionId),
  ])
  const identity = JSON.stringify([
    stream._id,
    stream.generation,
    stream.sessionId,
    stream.agentId,
    stream.state.processingMessageId,
    boundary.floor,
    boundary.upper,
    boundary.summary?._id,
    state?.completedHistoryRevision ?? 0,
  ])
  const [completed, live] = await Promise.all([
    knownHistory === identity ? null : readCompleted(ctx, stream, boundary),
    readLive(ctx, stream, boundary.floor),
  ])

  return { identity, completed, live }
}

async function readCompleted(
  ctx: QueryCtx,
  stream: Doc<'streams'>,
  { floor, upper, summary }: Boundary,
) {
  const messages = await listDoneHistory(ctx, stream.sessionId, floor, upper)
  const ordered = summary
    ? [summary, ...messages.filter((message) => message._id !== summary._id)]
    : messages
  return withPartsMany(
    ctx,
    ordered.filter((row) => visibleToAgent(row, stream)),
  )
}

async function readLive(ctx: QueryCtx, stream: Doc<'streams'>, floor: number) {
  const currentId = stream.state.processingMessageId
  if (!currentId) return { notes: [], current: null }
  const notes = await ctx.db
    .query('messages')
    .withIndex('by_sessionId_contextAnchor', (q) =>
      q
        .eq('sessionId', stream.sessionId)
        .eq('extra.anchorMessageId', currentId),
    )
    .collect()

  const includeCurrent =
    stream.command.kind === 'invoke' || stream.command.kind === 'retry'
  const current = includeCurrent ? await ctx.db.get(currentId) : null
  const visible = notes.filter(
    (note) =>
      note.contextEligible &&
      note._creationTime > floor &&
      visibleToAgent(note, stream),
  )
  const [joinedNotes, joinedCurrent] = await Promise.all([
    withPartsMany(ctx, visible),
    current ? withParts(ctx, current) : null,
  ])

  return { notes: joinedNotes, current: joinedCurrent }
}

function visibleToAgent(message: Doc<'messages'>, stream: Doc<'streams'>) {
  return message.type !== 'mcp' || message.sender.id === stream.agentId
}

export function assembleProviderHistory(
  completed: MessageWithParts[],
  live: Awaited<ReturnType<typeof readLive>>,
) {
  const completedIds = new Set(completed.map(({ _id }) => _id))
  return orderContextNotes([
    ...completed,
    ...live.notes.filter((row) => !completedIds.has(row._id)),
    ...(live.current?.parts.length ? [live.current] : []),
  ])
}

export function listDoneHistory(
  ctx: QueryCtx,
  sessionId: Id<'sessions'>,
  floor: number,
  upper: number,
) {
  if (floor >= upper) return []
  return ctx.db
    .query('messages')
    .withIndex('by_sessionId_status_contextEligible', (q) =>
      q
        .eq('sessionId', sessionId)
        .eq('status', 'done')
        .eq('contextEligible', true)
        .gt('_creationTime', floor)
        .lte('_creationTime', upper),
    )
    .order('asc')
    .collect()
}
