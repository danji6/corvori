import type { Id } from '../../_generated/dataModel'
import { error } from '../../errors'
import type { AuthMutationCtx } from '../../functions'
import { insertMessage } from '../messageContents'
import { collectStarterPrompts, mergePrompts } from '../prompt/prompts'
import { reserveMessageEvaluation } from '../promptEvaluation/reserve'
import { resolveSets as resolvePromptSets } from '../prompts'
import { agentIdentity } from './identities'

export async function maybeInsertStarters(
  ctx: AuthMutationCtx,
  session: {
    _id: Id<'sessions'>
    activeAgentId?: Id<'agents'>
  },
) {
  if (!session.activeAgentId) return

  const existing = await ctx.db
    .query('messages')
    .withIndex('by_sessionId', (q) => q.eq('sessionId', session._id))
    .filter((q) =>
      q.and(
        q.neq(q.field('type'), 'contextReset'),
        q.neq(q.field('type'), 'presence'),
      ),
    )
    .first()
  if (existing) return

  const agent = await ctx.db.get(session.activeAgentId)
  if (!agent) error('Agent not found', 404)

  const sets = await resolvePromptSets(ctx, agent)

  const prompts = mergePrompts({ ...agent, prompts: sets.own }, sets.library)
  const starters = collectStarterPrompts(prompts)
  if (starters.length === 0) return

  const identity = agentIdentity(agent)

  for (const prompt of starters) {
    const parts = [{ type: 'text', text: prompt.content }]
    const { messageId, contentId } = await insertMessage(
      ctx,
      {
        sessionId: session._id,
        sender: { type: 'agent', id: agent._id },
        role: prompt.role,
        ...identity,
        status: 'done',
      },
      parts,
    )
    await reserveMessageEvaluation(ctx, {
      agent,
      sessionId: session._id,
      messageId,
      contentId,
      invokedBy: ctx.userId,
      parts,
      origin: 'starter',
      promptId: prompt.id,
    })
  }
}
