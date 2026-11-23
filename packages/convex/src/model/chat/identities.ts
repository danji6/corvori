import type { MessageRole } from '@cv/core/types/roles'

import type { Doc } from '../../_generated/dataModel'
import type { MutationCtx } from '../../_generated/server'
import { error } from '../../errors'
import type { AuthMutationCtx } from '../../functions'

export async function resolveSender(
  ctx: AuthMutationCtx,
  session: Doc<'sessions'>,
  role: MessageRole,
) {
  if (role !== 'assistant') return { type: 'user' as const, id: ctx.userId }

  if (!session.activeAgentId) error('No active agent', 409)
  const agent = await ctx.db.get(session.activeAgentId)
  if (!agent) error('Agent not found', 404)
  return { type: 'agent' as const, id: agent._id }
}

/** Resolves the author of a stream's output when the stream is claimed. */
export async function resolveStreamSender(
  ctx: MutationCtx,
  stream: Pick<Doc<'streams'>, 'command' | 'agentId' | 'invokedBy'>,
) {
  if (stream.command.kind === 'impersonate') {
    return {
      sender: { type: 'user' as const, id: stream.invokedBy },
      role: 'user' as const,
    }
  }

  const agent = await ctx.db.get(stream.agentId)
  if (!agent) error('Agent not found', 404)
  return {
    sender: { type: 'agent' as const, id: stream.agentId },
    role: 'assistant' as const,
  }
}
