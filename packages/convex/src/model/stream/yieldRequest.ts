import { DEFAULT_YIELD_CONFIRM_MS } from '@cv/core/const'
import { hasPendingQuestions } from '@cv/core/utils/ask'
import { hasPendingToolApprovals } from '@cv/core/utils/tool-parts'
import {
  type PendingYieldPart,
  failYieldParts,
  isPendingYieldPart,
} from '@cv/core/utils/yield'

import { internal } from '../../_generated/api'
import type { Doc, Id } from '../../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../../_generated/server'
import { patchSegmentParts } from '../messageContents'
import type { Session } from '../session/types'
import { sessionToolNames } from '../tool/selection'
import { APPROVAL_LEASE_MS } from './lifecycleClaims'
import { _recordStep } from './lifecycleProgress'
import type { RunningStream } from './types'

type YieldStep = {
  stream: RunningStream
  session: Session
  row: Doc<'messageContents'>
  parts: unknown[]
}

type YieldOutcome = { parked: boolean; parts: unknown[] }

/**
 * Parks a step on its yield call until people confirm who responds next.
 * A call that cannot be honored fails instead, so the turn continues.
 */
export async function requestYield(
  ctx: MutationCtx,
  step: YieldStep,
): Promise<YieldOutcome> {
  const { stream, row } = step
  const calls = step.parts.filter(isPendingYieldPart)
  const target = await resolveRequest(ctx, step, calls)

  if (typeof target === 'string') {
    const parts = failYieldParts(step.parts, target)
    await patchSegmentParts(ctx, stream.state.processingMessageId, row, parts)
    return { parked: false, parts }
  }

  const { _id: streamId, generation } = stream
  await _recordStep(ctx, { streamId, generation, interruptible: false })
  await parkYield(ctx, step, calls[0].toolCallId, target._id)
  return { parked: true, parts: step.parts }
}

/** Returns the requested agent, or the reason the request is rejected. */
async function resolveRequest(
  ctx: QueryCtx,
  { stream, session, parts }: YieldStep,
  calls: PendingYieldPart[],
): Promise<Doc<'agents'> | string> {
  if (calls.length > 1) return 'Call yield only once per turn.'

  const blockedByOtherRequests =
    hasPendingQuestions(parts) || hasPendingToolApprovals(parts)
  if (blockedByOtherRequests) {
    return 'Yield cannot be combined with questions or tool calls awaiting approval. Call it again on its own.'
  }

  const agent = await ctx.db.get(stream.agentId)
  const tools = agent
    ? await sessionToolNames(ctx, session._id, agent, stream.invokedBy)
    : []
  if (!tools.includes('yield')) return 'Handing off turns is no longer enabled.'

  const name = String(calls[0].input?.name ?? '').trim()
  const targets = await listYieldTargets(ctx, stream)
  const matches = targets.filter((target) => sameName(target.name, name))
  if (matches.length === 0) {
    return `No other agent named "${name}" is in this conversation.`
  }

  // Names are only unique per owner, so a shared name picks one at random
  return matches[Math.floor(Math.random() * matches.length)]
}

function sameName(left: string, right: string) {
  return left.trim().toLowerCase() === right.toLowerCase()
}

/** Suspends the turn and schedules the request's automatic acceptance. */
async function parkYield(
  ctx: MutationCtx,
  { stream, session }: YieldStep,
  toolCallId: string,
  targetAgentId: Id<'agents'>,
) {
  const delayMs = session.settings?.yieldConfirmMs ?? DEFAULT_YIELD_CONFIRM_MS
  const fireAt = Date.now() + delayMs
  const jobId = await ctx.scheduler.runAt(fireAt, internal.chat._expireYield, {
    streamId: stream._id,
    toolCallId,
  })

  await ctx.db.patch(stream._id, {
    state: {
      phase: 'awaiting_input',
      processingMessageId: stream.state.processingMessageId,
      processingContentId: stream.state.processingContentId,
      yield: { toolCallId, targetAgentId, fireAt, jobId },
    },
    attempt: 0,
    leaseExpiresAt: Date.now() + APPROVAL_LEASE_MS,
  })
}

type YieldingStream = Pick<Doc<'streams'>, 'sessionId' | 'agentId'>

/** Lists the linked agents that can take over from the yielding one. */
export async function listYieldTargets(
  ctx: QueryCtx,
  stream: YieldingStream,
): Promise<Doc<'agents'>[]> {
  const links = await ctx.db
    .query('sessionAgents')
    .withIndex('by_sessionId', (q) => q.eq('sessionId', stream.sessionId))
    .collect()

  const targets: Doc<'agents'>[] = []
  for (const link of links) {
    if (link.agentId === stream.agentId) continue
    const agent = await ctx.db.get(link.agentId)
    if (agent && (await isAvailable(ctx, agent))) targets.push(agent)
  }
  return targets
}

/** Excludes agents whose personal folder is mid-update. */
async function isAvailable(ctx: QueryCtx, agent: Doc<'agents'>) {
  if (agent.fileOperationId) return false
  const home = agent.homeId ? await ctx.db.get(agent.homeId) : null
  return !home?.operationId
}
