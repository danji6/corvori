import type { ShellToolOutput } from '@cv/core/types/tools'
import type { Infer } from 'convex/values'

import type { Id } from '../../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../../_generated/server'
import type { AuthQueryCtx } from '../../functions'
import { sharedSessionId } from '../../lib/subagent'
import type {
  shellOriginArgsValidator,
  shellReferenceArgsValidator,
} from '../../validators/shell'
import { listSelectedSegments } from '../messageContents'
import { getMembership } from '../session/memberships'

type ReferenceArgs = Infer<typeof shellReferenceArgsValidator>
type OriginArgs = Infer<typeof shellOriginArgsValidator>

export function findReference(
  ctx: QueryCtx,
  { sessionId, jobId }: ReferenceArgs,
) {
  if (/^[1-9][0-9]*$/.test(jobId)) {
    return ctx.db
      .query('shellReferences')
      .withIndex('by_sessionId_number', (q) =>
        q.eq('sessionId', sessionId).eq('number', Number(jobId)),
      )
      .unique()
  }
  return ctx.db
    .query('shellReferences')
    .withIndex('by_sessionId_jobId', (q) =>
      q.eq('sessionId', sessionId).eq('jobId', jobId),
    )
    .unique()
}

/** Allocates a number in the shared chat transactionally, including child jobs. */
export async function bindReference(
  ctx: MutationCtx,
  args: ReferenceArgs & OriginArgs,
) {
  const existing = await findReference(ctx, args)
  if (existing) return existing.number

  const message = await ctx.db.get(args.messageId)
  const owner = message && (await ctx.db.get(message.sessionId))
  if (!owner || sharedSessionId(owner) !== args.sessionId) return undefined

  const session = await ctx.db.get(args.sessionId)
  if (!session) return undefined
  const number = (session.lastShellJobNumber ?? 0) + 1
  await ctx.db.patch(session._id, { lastShellJobNumber: number })
  await ctx.db.insert('shellReferences', {
    ...args,
    number,
    version: message.selectedVersion,
  })
  return number
}

/** Keeps one bounded snapshot available at the original command. */
export async function saveTerminal(
  ctx: MutationCtx,
  sessionId: Id<'sessions'>,
  output: ShellToolOutput,
) {
  if (!output.jobId || output.status === 'lost' || output.status === 'running')
    return
  const ref = await findReference(ctx, { sessionId, jobId: output.jobId })
  if (!ref) return
  const previous = ref.terminal
  if (previous) {
    if (previous.status !== 'background' && output.status === 'background')
      return
    if (
      previous.termOffset + previous.term.length >
      output.termOffset + output.term.length
    )
      return
  }
  await ctx.db.patch(ref._id, {
    terminal: { ...output, text: '', range: undefined },
  })
}

export async function transcriptReference(
  ctx: AuthQueryCtx,
  args: ReferenceArgs,
) {
  const session = await ctx.db.get(args.sessionId)
  if (!session) return null
  const sessionId = sharedSessionId(session)
  const member =
    (await getMembership(ctx, sessionId, ctx.userId)) ??
    (await getMembership(ctx, session._id, ctx.userId))
  if (!member) return null

  const ref = await findReference(ctx, { ...args, sessionId })
  if (!ref) return null
  const message = await ctx.db.get(ref.messageId)
  if (!message || message.hidden || ref.version !== message.selectedVersion)
    return null
  if (message.sessionId !== args.sessionId && member.sessionId !== sessionId)
    return null

  const segments = await listSelectedSegments(ctx, message)
  const segment = segments.find(({ parts }) =>
    parts.some((part) => {
      const tool = part as { type?: string; toolCallId?: string } | null
      return tool?.type === 'tool-shell' && tool.toolCallId === ref.toolCallId
    }),
  )
  if (!segment) return null

  return {
    messageId: ref.messageId,
    messageCreatedAt: message._creationTime,
    sessionId: message.sessionId,
    segmentIndex: segment.segmentIndex,
    toolCallId: ref.toolCallId,
    number: ref.number,
    terminal: ref.terminal,
  }
}

/** Drops output snapshots when their source transcript is deleted. */
export async function removeShellReferences(
  ctx: MutationCtx,
  messageId: Id<'messages'>,
  version?: number,
) {
  const refs = await ctx.db
    .query('shellReferences')
    .withIndex('by_messageId_version', (q) => {
      const message = q.eq('messageId', messageId)
      return version === undefined ? message : message.eq('version', version)
    })
    .collect()
  for (const ref of refs) await ctx.db.delete(ref._id)
}
