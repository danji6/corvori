import type { DeclinedYieldToolOutput } from '@cv/core/types'
import { toDisplayName } from '@cv/core/utils/names'
import {
  type PendingYieldPart,
  failYieldParts,
  isPendingYieldPart,
  settleYieldParts,
} from '@cv/core/utils/yield'

import type { Doc, Id } from '../../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../../_generated/server'
import { error } from '../../errors'
import type { AuthMutationCtx } from '../../functions'
import type {
  ResolveYieldArgs,
  StreamState,
  YieldRequest,
  YieldRequestArgs,
} from '../../validators/streams'
import { getProcessingSegmentRow, patchSegmentParts } from '../messageContents'
import * as Memberships from '../session/memberships'
import { getByOwnerId as getSettingsByOwnerId } from '../settings'
import { cancelScheduledExecution, scheduleStream } from '../stream/execution'
import { APPROVAL_LEASE_MS } from '../stream/lifecycleClaims'
import { completeStream } from '../stream/lifecycleTerminal'
import { listYieldTargets } from '../stream/yieldRequest'

type ParkedYieldStream = Omit<Doc<'streams'>, 'state'> & {
  state: Extract<StreamState, { phase: 'awaiting_input' }>
}

type PendingYield = {
  stream: ParkedYieldStream
  request: YieldRequest
  row: Doc<'messageContents'>
  part: PendingYieldPart
}

type ExpireYieldArgs = { streamId: Id<'streams'>; toolCallId: string }

/** Hands the turn to the requested agent, or to the one a member picked. */
export async function acceptYield(
  ctx: AuthMutationCtx,
  args: ResolveYieldArgs,
) {
  const pending = await requireMemberYield(ctx, args)
  const agentId = args.agentId ?? pending.request.targetAgentId
  const target = await findTarget(ctx, pending.stream, agentId)
  if (!target) error('Agent is not available', 409)

  await cancelScheduledExecution(ctx, pending.stream)
  await handOff(ctx, pending, target, ctx.userId)
}

/** Stops the countdown for everyone so a member can pick another agent. */
export async function pauseYield(ctx: AuthMutationCtx, args: YieldRequestArgs) {
  const { stream, request } = await requireMemberYield(ctx, args)
  if (!request.fireAt) return

  await cancelScheduledExecution(ctx, stream)
  const { toolCallId, targetAgentId } = request
  await ctx.db.patch(stream._id, {
    state: { ...stream.state, yield: { toolCallId, targetAgentId } },
    leaseExpiresAt: Date.now() + APPROVAL_LEASE_MS,
  })
}

/** Dismisses the request and ends the yielding agent's turn. */
export async function cancelYield(
  ctx: AuthMutationCtx,
  args: YieldRequestArgs,
) {
  const pending = await requireMemberYield(ctx, args)
  const settings = await getSettingsByOwnerId(ctx, ctx.userId)
  const name = toDisplayName(settings?.displayName)

  await cancelScheduledExecution(ctx, pending.stream)
  await settle(ctx, pending, {
    accepted: false,
    reason: `${name} cancelled this request.`,
  })
  await completeStream(ctx, pending.stream)
}

/** Accepts a request nobody changed or cancelled before its countdown ended. */
export async function expireYield(
  ctx: MutationCtx,
  { streamId, toolCallId }: ExpireYieldArgs,
) {
  const pending = await findPendingYield(ctx, await ctx.db.get(streamId), {
    toolCallId,
  })
  // A paused request no longer expires on its own
  if (!pending?.request.fireAt) return

  const { stream, request } = pending
  const target = await findTarget(ctx, stream, request.targetAgentId)
  if (!target) {
    await resumeWithoutTarget(ctx, pending)
    return
  }

  // This job is the countdown itself, so there is nothing left to cancel
  await handOff(ctx, pending, target, stream.invokedBy)
}

async function requireMemberYield(
  ctx: AuthMutationCtx,
  args: YieldRequestArgs,
): Promise<PendingYield> {
  const { session } = await Memberships.requireMember(
    ctx,
    args.sessionId,
    ctx.userId,
  )
  Memberships.requireEnabled(session)

  const stream = await Memberships.getActiveStream(ctx, args.sessionId)
  const pending = await findPendingYield(ctx, stream, args)
  if (!pending) error('No yield request is pending', 409)
  return pending
}

/** Matches a parked stream's request with its still unsettled tool call. */
async function findPendingYield(
  ctx: QueryCtx,
  stream: Doc<'streams'> | null,
  { toolCallId }: Pick<YieldRequestArgs, 'toolCallId'>,
): Promise<PendingYield | null> {
  if (stream?.state.phase !== 'awaiting_input') return null

  const request = stream.state.yield
  if (request?.toolCallId !== toolCallId) return null

  const row = await getProcessingSegmentRow(ctx, stream)
  const part = row?.parts.find(
    (candidate): candidate is PendingYieldPart =>
      isPendingYieldPart(candidate) && candidate.toolCallId === toolCallId,
  )
  if (!row || !part) return null

  return { stream: stream as ParkedYieldStream, request, row, part }
}

async function findTarget(
  ctx: QueryCtx,
  stream: ParkedYieldStream,
  agentId: Id<'agents'>,
) {
  const targets = await listYieldTargets(ctx, stream)
  return targets.find((target) => target._id === agentId)
}

/** Makes the target the active agent and starts its turn as this one ends. */
async function handOff(
  ctx: MutationCtx,
  pending: PendingYield,
  target: Doc<'agents'>,
  invokedBy: Id<'users'>,
) {
  const { stream } = pending
  await settleAccepted(ctx, pending, target.name)
  await ctx.db.patch(stream.sessionId, { activeAgentId: target._id })
  await completeStream(ctx, stream, { handOff: { invokedBy } })
}

async function settleAccepted(
  ctx: MutationCtx,
  { stream, row, part }: PendingYield,
  agent: string,
) {
  const parts = row.parts.map((candidate) =>
    candidate === part
      ? {
          ...part,
          state: 'output-available',
          output: { accepted: true, agent },
        }
      : candidate,
  )
  await patchSegmentParts(ctx, stream.state.processingMessageId, row, parts)
}

async function settle(
  ctx: MutationCtx,
  { stream, row }: PendingYield,
  output: DeclinedYieldToolOutput,
) {
  const parts = settleYieldParts(row.parts, output)
  await patchSegmentParts(ctx, stream.state.processingMessageId, row, parts)
}

/** Fails the call when its agent left during the countdown, resuming the turn. */
async function resumeWithoutTarget(
  ctx: MutationCtx,
  { stream, row }: PendingYield,
) {
  const parts = failYieldParts(
    row.parts,
    'The requested agent is no longer available.',
  )
  await patchSegmentParts(ctx, stream.state.processingMessageId, row, parts)
  // Rescheduling must not cancel the countdown job that is running this
  await ctx.db.patch(stream._id, {
    state: { ...stream.state, yield: undefined },
  })
  await scheduleStream(ctx, stream._id, { resetAttempt: true })
}
