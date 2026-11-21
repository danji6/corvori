import { sha256 } from '@cv/core/sha256'

import type { Doc, Id } from '../../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../../_generated/server'
import { error } from '../../errors'
import { requireRole } from '../../functions'
import type { AgentWithHome, Session } from '../../types'
import { requireEnabled, requireMember } from '../session/memberships'
import { agentWithHome } from '../skills/homes'
import { findUserBySubject } from '../users'

export async function checkpointAgents(
  ctx: QueryCtx,
  group: Doc<'changeSets'>[],
) {
  const agents = await Promise.all(
    [...new Set(group.map((item) => item.agentId))].map((id) =>
      agentWithHome(ctx, id),
    ),
  )
  return agents.filter((agent) => agent !== null)
}

export function checkpointLocations(
  row: Doc<'changeSets'>,
  workspace: Session['workspace'],
  agents: AgentWithHome[],
) {
  return {
    project: workspace?.sources?.map((source) => source.path) ?? [],
    homes: agents.flatMap(({ home }) => (home?.path ? [home.path] : [])),
    sessionFiles: row.workspace.sessionFiles ?? false,
  }
}

export function checkpointLocationKey(
  locations: ReturnType<typeof checkpointLocations>,
) {
  return sha256(JSON.stringify(locations))
}

export async function restoreContext(
  ctx: QueryCtx,
  args: { changeSetId: Id<'changeSets'>; subject?: string },
) {
  const row = await ctx.db.get(args.changeSetId)
  if (!row) return null

  const requester = args.subject
    ? await findUserBySubject(ctx, args.subject)
    : row.requestedBy && (await ctx.db.get(row.requestedBy))
  if (!requester) error('Restore requester is missing', 409)
  requireRole(requester.role, 'admin')
  const { session } = await requireMember(ctx, row.sessionId, requester._id)
  requireEnabled(session)

  const group = await ctx.db
    .query('changeSets')
    .withIndex('by_groupId', (q) => q.eq('groupId', row.groupId))
    .collect()
  const agents = await checkpointAgents(ctx, group)
  const workspace = session.workspace
  return {
    row,
    workspace,
    agents,
    locations: checkpointLocations(row, workspace, agents),
  }
}

type StaleArgs = {
  changeSetId: Id<'changeSets'>
  subject: string
  locationKey: string
}

/** Commits an observed path change only while the checked configuration is current. */
export async function markChangesStale(ctx: MutationCtx, args: StaleArgs) {
  const current = await restoreContext(ctx, args)
  if (current?.row.phase !== 'ready' || !current.row.writersSettled)
    return false
  if (args.locationKey !== (await checkpointLocationKey(current.locations)))
    return false

  await ctx.db.patch(current.row._id, { phase: 'stale' })
  return true
}
