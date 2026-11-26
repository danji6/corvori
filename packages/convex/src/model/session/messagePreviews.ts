import type { Id } from '../../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../../_generated/server'
import { isShellToolPart } from '../../lib/userShell'
import { withParts } from '../messageContents'
import { messagePreview } from '../messages'

/** Refreshes cached previews after removing messages from the transcript. */
export async function refreshMessagePreviews(
  ctx: MutationCtx,
  sessionId: Id<'sessions'>,
) {
  const session = await ctx.db.get(sessionId)
  if (!session?.lastMessagePreview && !session?.firstMessagePreview) return

  const lastMessagePreview = await findPreview(ctx, sessionId, 'desc')
  const firstMessagePreview = session.firstMessagePreview
    ? await findPreview(ctx, sessionId, 'asc')
    : undefined

  const previewsChanged =
    lastMessagePreview !== session.lastMessagePreview ||
    firstMessagePreview !== session.firstMessagePreview
  if (previewsChanged) {
    await ctx.db.patch(sessionId, { lastMessagePreview, firstMessagePreview })
  }
}

async function findPreview(
  ctx: QueryCtx,
  sessionId: Id<'sessions'>,
  order: 'asc' | 'desc',
) {
  const messages = ctx.db
    .query('messages')
    .withIndex('by_sessionId_position', (q) => q.eq('sessionId', sessionId))
    .order(order)

  for await (const message of messages) {
    if (message.hidden || message.type === 'summary') continue
    if (message.role === 'assistant' && message.status === 'processing')
      continue

    const { parts } = await withParts(ctx, message)
    const preview = messagePreview(parts)
    if (preview) return preview

    if (message.role === 'user') {
      const command = parts.find(isShellToolPart)?.input?.command
      if (command) return messagePreview(`$ ${command}`)
    }
  }
}
