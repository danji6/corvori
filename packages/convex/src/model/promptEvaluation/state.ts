import type { Doc, Id } from '../../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../../_generated/server'
import { minRole } from '../../lib/roles'
import type { StreamExecutionArgs } from '../../validators/streams'
import { modelOverrideView } from '../agent/modelOverride'
import { segmentCapError } from '../caps'
import { resolve as resolveMcpServers } from '../mcp/servers'
import { getProcessingSegmentRow, setSegmentParts } from '../messageContents'
import {
  isEvaluationPlaceholder,
  partsHaveScript,
  replaceEvaluationPlaceholders,
  scheduleTitle,
} from '../messages'
import { findOverride } from '../session/authorProfiles'
import { getSessionWithWorkspace } from '../session/folderContext'
import {
  countParticipants,
  getActiveStream,
  getMembership,
} from '../session/memberships'
import { getState, patchState } from '../session/state'
import { getByOwnerId } from '../settings'
import { agentWithHome } from '../skills/homes'
import { ownsExecution } from '../stream/execution'
import {
  replaysProcessingMessage,
  resolveHistoryBoundary,
} from '../stream/historyBoundary'
import { listItems, listPending } from './records'

type Evaluation = Doc<'promptEvaluations'>

type EvaluationId = Id<'promptEvaluations'>

export async function current(ctx: QueryCtx, evaluation: Evaluation) {
  const { target, _id } = evaluation

  if (target.kind === 'snapshot')
    return (await ctx.db.get(target.cacheId))?.promptEvaluationId === _id
  if (target.kind === 'operation')
    return (await ctx.db.get(target.streamId))?.promptEvaluationId === _id

  return (await ctx.db.get(target.contentId))?.promptEvaluationId === _id
}

export async function shellAllowed(ctx: QueryCtx, evaluation: Evaluation) {
  const { target, invokedBy, ownerId, agentId } = evaluation

  if (target.kind === 'message') {
    if (target.origin === 'transcript') return false

    if (target.origin === 'userSend') {
      const invoker = await ctx.db.get(invokedBy)
      if (
        !invoker ||
        invoker._id !== ownerId ||
        !minRole(invoker.role, 'admin')
      ) {
        return false
      }
      return Boolean(await getMembership(ctx, evaluation.sessionId, invokedBy))
    }
  }
  if (!agentId) return false

  const [invoker, owner, agent] = await Promise.all([
    ctx.db.get(invokedBy),
    ctx.db.get(ownerId),
    ctx.db.get(agentId),
  ])

  return !!(
    invoker &&
    owner &&
    agent?.ownerId === owner._id &&
    minRole(invoker.role, 'admin') &&
    minRole(owner.role, 'admin')
  )
}

export async function readState(ctx: QueryCtx, { id }: { id: EvaluationId }) {
  const evaluation = await ctx.db.get(id)
  if (!evaluation || !(await current(ctx, evaluation))) return null
  return {
    evaluation,
    allowed:
      evaluation.state === 'pending' && (await shellAllowed(ctx, evaluation)),
  }
}

export async function readInput(ctx: QueryCtx, { id }: { id: EvaluationId }) {
  const state = await readState(ctx, { id })
  if (!state || state.evaluation.state !== 'pending') return null

  const { sessionId, agentId, ownerId, invokedBy } = state.evaluation
  const [agent, session, invoker, invokerSettings, counts, vars, items] =
    await Promise.all([
      agentId ? agentWithHome(ctx, agentId) : null,
      getSessionWithWorkspace(ctx, sessionId),
      ctx.db.get(invokedBy),
      getByOwnerId(ctx, invokedBy),
      countParticipants(ctx, sessionId),
      getState(ctx, sessionId),
      listItems(ctx, id),
    ])
  if (!session || !invoker) return null

  const { target } = state.evaluation
  const message = target.kind === 'message'
  const configured = !message || 'promptId' in target
  if (configured && (!agent || !(await ctx.db.get(ownerId)))) return null

  const [ownerSettings, mcpServers, model, userOverride, agentOverride] =
    await Promise.all([
      agent ? getByOwnerId(ctx, agent.ownerId) : null,
      message && agent ? resolveMcpServers(ctx, agent.ownerId) : [],
      message && agent?.modelOverride
        ? modelOverrideView(ctx, agent.ownerId, agent.modelOverride)
        : undefined,
      findOverride(ctx, sessionId, { type: 'user', id: invokedBy }),
      agent
        ? findOverride(ctx, sessionId, { type: 'agent', id: agent._id })
        : null,
    ])

  return {
    ...state,
    agent,
    session,
    invoker,
    invokerSettings,
    ownerSettings,
    userNameOverride: userOverride?.name,
    assistantNameOverride: agentOverride?.name,
    mcpServers,
    model,
    ...counts,
    unrestrictedShell: vars?.toolApprovals?.mode === 'unrestricted',
    environment: vars?.environment ?? {},
    items,
  }
}

export async function pinInstance(
  ctx: MutationCtx,
  { id, bootId }: { id: EvaluationId; bootId: string },
) {
  const state = await readState(ctx, { id })
  const row = state?.evaluation
  if (!row || row.state !== 'pending') return null
  if (row.bootId) return { bootId: row.bootId, start: false }
  await ctx.db.patch(id, { bootId })
  return { bootId, start: true }
}

export async function stageItem(
  ctx: MutationCtx,
  {
    id,
    itemId,
    content,
  }: {
    id: EvaluationId
    itemId: Id<'promptEvaluationItems'>
    content: string
  },
) {
  const evaluation = await ctx.db.get(id)
  if (evaluation?.state !== 'pending' || !(await current(ctx, evaluation)))
    return

  const item = await ctx.db.get(itemId)
  if (item?.evaluationId === id && 'content' in item.item) {
    const rendered = { ...item.item, content }
    await ctx.db.patch(itemId, { item: rendered })
  }
}

type Completion = {
  id: EvaluationId
  parts?: unknown[]
  writes?: Record<string, unknown>
  error?: string
}

export async function finishEvaluation(ctx: MutationCtx, args: Completion) {
  const evaluation = await ctx.db.get(args.id)
  if (evaluation?.state !== 'pending' || !(await current(ctx, evaluation)))
    return false

  if (
    evaluation.target.kind === 'message' &&
    !(await publishMessage(ctx, evaluation.target, args))
  ) {
    return false
  }

  if (!args.error && args.writes && Object.keys(args.writes).length) {
    const state = await getState(ctx, evaluation.sessionId)
    await patchState(ctx, evaluation.sessionId, {
      environment: { ...state?.environment, ...args.writes },
    })
  }

  await ctx.db.patch(args.id, {
    state: args.error ? 'failed' : 'complete',
    finishedAt: Date.now(),
    error: args.error,
    inputParts: undefined,
  })

  const { target, sessionId } = evaluation
  if (target.kind === 'message' && target.origin === 'userSend')
    await maybeScheduleTitle(ctx, sessionId, target.messageId)

  return true
}

type MessageTarget = Extract<Evaluation['target'], { kind: 'message' }>

async function publishMessage(
  ctx: MutationCtx,
  target: MessageTarget,
  args: Completion,
) {
  const [row, message] = await Promise.all([
    ctx.db.get(target.contentId),
    ctx.db.get(target.messageId),
  ])
  if (!row || !message) return false

  const parts = messageResultParts(row, target, args)
  await setSegmentParts(ctx, message, row, parts, args.id)

  return true
}

function messageResultParts(
  row: Doc<'messageContents'>,
  target: MessageTarget,
  args: Completion,
) {
  const configured = 'promptId' in target

  const errorParts = (text: string) =>
    configured
      ? [{ type: 'text', text }]
      : replaceEvaluationPlaceholders(row.parts, text)

  if (args.error) return errorParts(args.error)

  const parts = configured
    ? (args.parts ?? [])
    : row.parts.map((part, index) =>
        isEvaluationPlaceholder(part) ? (args.parts?.[index] ?? part) : part,
      )
  const capError = segmentCapError(parts)

  return capError
    ? errorParts('Error: evaluated output exceeds the message size limit')
    : parts
}

async function maybeScheduleTitle(
  ctx: MutationCtx,
  sessionId: Id<'sessions'>,
  messageId: Id<'messages'>,
) {
  if (await getActiveStream(ctx, sessionId)) return
  const pending = await listPending(ctx, sessionId)
  const messagePending = pending.some(
    ({ target }) => target.kind === 'message' && target.messageId === messageId,
  )
  if (!messagePending) await scheduleTitle(ctx, sessionId)
}

export async function readResult(ctx: QueryCtx, { id }: { id: EvaluationId }) {
  const row = await ctx.db.get(id)
  if (row?.state !== 'complete') return null
  return (await listItems(ctx, id)).map(({ item }) => item)
}

/** Waits only for live occurrences inside the current provider history range. */
export async function pendingHistory(
  ctx: QueryCtx,
  execution: StreamExecutionArgs,
) {
  const stream = await ctx.db.get(execution.streamId)
  if (!ownsExecution(stream, execution)) return null
  const boundary = await resolveHistoryBoundary(ctx, stream)
  return historyEvaluationStatus(ctx, stream, boundary)
}

type HistoryBoundary = Awaited<ReturnType<typeof resolveHistoryBoundary>>

export async function historyEvaluationStatus(
  ctx: QueryCtx,
  stream: Doc<'streams'>,
  boundary: HistoryBoundary,
) {
  const live = replaysProcessingMessage(stream.command)

  const [pending, failed, row] = await Promise.all([
    listPending(ctx, stream.sessionId),
    ctx.db
      .query('promptEvaluations')
      .withIndex('by_sessionId_state_finishedAt', (q) =>
        q
          .eq('sessionId', stream.sessionId)
          .eq('state', 'failed')
          .gte('finishedAt', stream._creationTime),
      )
      .collect(),
    live ? getProcessingSegmentRow(ctx, stream) : null,
  ])

  let error: string | undefined
  let waiting = false

  for (const evaluation of [...failed, ...pending]) {
    if (evaluation.target.kind !== 'message') continue
    const [message, row] = await Promise.all([
      ctx.db.get(evaluation.target.messageId),
      ctx.db.get(evaluation.target.contentId),
    ])
    if (!message || !row || row.promptEvaluationId !== evaluation._id) continue
    if (row.version !== message.selectedVersion) continue
    if (!inProviderHistory(message, stream, boundary)) continue
    if (evaluation.state === 'failed') error ??= evaluation.error
    else waiting = true
  }

  return {
    waiting,
    error,
    needsLiveEvaluation: Boolean(row && partsHaveScript(row.parts)),
  }
}

function inProviderHistory(
  message: Doc<'messages'>,
  stream: Doc<'streams'>,
  boundary: HistoryBoundary,
) {
  const current = stream.state.processingMessageId
  if (current && current === message._id)
    return replaysProcessingMessage(stream.command)

  if (!message.contextEligible) return false
  if (message.type === 'mcp' && message.sender.id !== stream.agentId) return false // prettier-ignore
  if (message._id === boundary.summary?._id) return true
  if (message._creationTime <= boundary.floor) return false

  const anchored =
    current &&
    message.extra &&
    'anchorMessageId' in message.extra &&
    message.extra.anchorMessageId === current

  return (
    Boolean(anchored) ||
    (message.status === 'done' && message._creationTime <= boundary.upper)
  )
}
