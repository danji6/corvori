import { sha256 } from '@cv/core/sha256'
import { SIDEBAR_STREAM_BATCH_SIZE } from '@cv/core/sidebar-streams'
import { isKnownTextFile } from '@cv/core/workspace/files'

import type { Doc, Id } from '../../_generated/dataModel'
import type { QueryCtx } from '../../_generated/server'
import { error } from '../../errors'
import type { AuthQueryCtx } from '../../functions'
import { minRole } from '../../lib/roles'
import { sharedSessionId } from '../../lib/subagent'
import type { StreamExecutionArgs } from '../../types'
import { resolveSpawnableAgents } from '../agent/subagents'
import {
  activeAttachmentMessages,
  hasLoadedAttachmentMedia,
} from '../attachments/media'
import { resolve as resolveMcpServers } from '../mcp/servers'
import { getProcessingSegmentRow, withParts } from '../messageContents'
import { getBySession as getPlan } from '../plans'
import { resolveSets as resolvePromptSets } from '../prompts'
import { resolve as resolveProviders } from '../provider/connections'
import { getBySessionAgent as getSessionCache } from '../session/cache'
import { getSessionWithWorkspace } from '../session/folderContext'
import { countParticipants, getMembership } from '../session/memberships'
import { getApprovals, getState } from '../session/state'
import { getByOwnerId as getSettings } from '../settings'
import { agentWithHome } from '../skills/homes'
import { hasStoredMcpOutput } from '../tool/availabilityRead'
import { availableToolkits } from '../toolkits/access'
import { toolkitSkillFingerprint } from '../toolkits/skillContext'
import { ownsExecution } from './execution'
import { resolveHistoryBoundary } from './historyBoundary'
import { listDoneHistory } from './providerHistory'

export { _getProviderHistory } from './providerHistory'

export async function activeSessionIdsForSessions(
  ctx: AuthQueryCtx,
  { sessionIds }: { sessionIds: Id<'sessions'>[] },
) {
  if (sessionIds.length > SIDEBAR_STREAM_BATCH_SIZE) {
    error('Too many sessions in a streaming status request', 400)
  }

  return findStreamingSessions([...new Set(sessionIds)], async (id) => {
    const membership = await getMembership(ctx, id, ctx.userId)
    return membership ? hasSessionStream(ctx, id) : false
  })
}

async function findStreamingSessions(
  ids: Id<'sessions'>[],
  hasStream: (id: Id<'sessions'>) => Promise<boolean>,
) {
  const streaming = await Promise.all(ids.map(hasStream))
  return ids.filter((_, index) => streaming[index])
}

async function hasSessionStream(ctx: QueryCtx, sessionId: Id<'sessions'>) {
  const stream = await ctx.db
    .query('streams')
    .withIndex('by_sessionId', (q) => q.eq('sessionId', sessionId))
    .first()
  return stream !== null
}

export async function _getContext(
  ctx: QueryCtx,
  { streamId, generation }: StreamExecutionArgs,
) {
  const stream = await ctx.db.get(streamId)
  if (!ownsExecution(stream, { streamId, generation })) return null

  const [session, agent, invoker, output] = await Promise.all([
    getSessionWithWorkspace(ctx, stream.sessionId),
    agentWithHome(ctx, stream.agentId),
    ctx.db.get(stream.invokedBy),
    ctx.db.get(stream.state.processingMessageId),
  ])
  if (!session || !agent || !invoker || !output) return null

  const owner = await ctx.db.get(agent.ownerId)
  if (!owner) return null

  // The engine loop only ever sees the active segment's parts
  const outputRow = await getProcessingSegmentRow(ctx, stream)

  const [
    settings,
    invokerSettings,
    participants,
    plan,
    prompts,
    mcpServers,
    modelProviders,
  ] = await Promise.all([
    getSettings(ctx, agent.ownerId),
    getSettings(ctx, invoker._id),
    countParticipants(ctx, stream.sessionId),
    // Sub-agents can see and edit the parent's plan
    getPlan(ctx, sharedSessionId(session)),
    resolvePromptSets(ctx, agent),
    resolveMcpServers(ctx, agent.ownerId, {
      withCredentials: true,
      agentId: agent._id,
      sessionId: stream.sessionId,
    }),
    resolveProviders(ctx, agent.ownerId),
  ])

  // Sub-agent sessions never spawn further sub-agents (flat only)
  const spawnableAgents =
    agent.tools?.includes('task') && !session.parent
      ? await resolveSpawnableAgents(ctx, agent)
      : []

  const sessionCache = await getSessionCache(
    ctx,
    stream.sessionId,
    stream.agentId,
    minRole(invoker.role, 'admin'),
  )

  const state = await getState(ctx, stream.sessionId)
  const toolkits = await availableToolkits(ctx, agent._id, stream.sessionId)

  return {
    sessionCache,
    environment: state?.environment ?? {},
    toolApprovals: await getApprovals(ctx, stream.sessionId),
    spawnableAgents,
    stream,
    session,
    agent,
    invoker,
    invokerSettings,
    owner,
    ownerSettings: settings,
    output: { ...output, parts: outputRow?.parts ?? [] },
    settings,
    prompts,
    toolkitContext: await Promise.all(
      toolkits.map(async (row) => ({
        id: row._id,
        name: row.name,
        fingerprint: await sha256(
          JSON.stringify([row.revision, row.skillsEnabled, row.disabledSkills]),
        ),
      })),
    ),
    toolkitSkillRevision: await toolkitSkillFingerprint(toolkits),
    toolkitCount: toolkits.length,
    hasStoredMcpOutput: agent.tools?.includes('mcp_access')
      ? await hasStoredMcpOutput(ctx, session._id, agent)
      : false,
    mcpServers,
    modelProviders,
    plan,
    ...participants,
  }
}

export async function _isActive(
  ctx: QueryCtx,
  { streamId, generation }: StreamExecutionArgs,
) {
  const stream = await ctx.db.get(streamId)
  return ownsExecution(stream, { streamId, generation })
}

/** Detects media loaded anywhere in the active debounced turn or tool step. */
async function getActiveMediaState(ctx: QueryCtx, stream: Doc<'streams'>) {
  const processing = stream.state.processingMessageId
    ? await ctx.db.get(stream.state.processingMessageId)
    : null
  if (processing) {
    const joined = await withParts(ctx, processing)
    if (hasLoadedAttachmentMedia(joined.parts)) return true
  }

  if (!stream.contextBoundaryMessageId) return false

  const { upper, floor, summary } = await resolveHistoryBoundary(ctx, stream)
  const history = await listDoneHistory(ctx, stream.sessionId, floor, upper)

  const activeIds = activeAttachmentMessages(
    history.filter((message) => message._id !== summary?._id),
    stream.contextBoundaryMessageId,
  )
  if (activeIds.size === 0) return false

  const attachments = await Promise.all(
    [...activeIds].map((messageId) =>
      ctx.db
        .query('attachments')
        .withIndex('by_messageId', (q) => q.eq('messageId', messageId))
        .collect(),
    ),
  )

  return attachments
    .flat()
    .some(
      (attachment) =>
        !isKnownTextFile(attachment.mediaType, attachment.filename),
    )
}

export async function _hasActiveMedia(
  ctx: QueryCtx,
  { streamId, generation }: StreamExecutionArgs,
) {
  const stream = await ctx.db.get(streamId)
  return ownsExecution(stream, { streamId, generation })
    ? getActiveMediaState(ctx, stream)
    : false
}

/** Reads stop state without putting ordinary seam checks in a mutation's read set. */
export async function _getStopState(
  ctx: QueryCtx,
  { streamId, generation }: StreamExecutionArgs,
) {
  const stream = await ctx.db.get(streamId)
  if (!ownsExecution(stream, { streamId, generation }))
    return 'stopped' as const
  return stream.stopAt ? ('requested' as const) : ('active' as const)
}
