import { clipReplyQuote, quotableText } from '@cv/core/reply-quote'

import type { Doc, Id } from '../../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../../_generated/server'
import { error } from '../../errors'
import type { ReplyQuote } from '../../types'
import { queryMessageSegments } from '../messageContents'

/** Snapshots the message a reply quotes, rejecting ones that can't be quoted. */
export async function quoteMessage(
  ctx: QueryCtx,
  sessionId: Id<'sessions'>,
  messageId: Id<'messages'>,
): Promise<ReplyQuote> {
  const message = await ctx.db.get(messageId)
  if (!message || message.sessionId !== sessionId) {
    error('Quoted message not found', 404)
  }

  // Notes, notices and other typed rows aren't part of the conversation
  const isConversationMessage = !message.type && !message.hidden
  if (!isConversationMessage) error('This message cannot be quoted')
  if (message.status === 'processing') error('Message is being processed', 409)

  return {
    target: { id: message._id, creationTime: message._creationTime },
    sender: message.sender,
    ...(message.senderName && { senderName: message.senderName }),
    text: clipReplyQuote(await quotedText(ctx, message)),
  }
}

/** Detaches replies from a deleted message and drops their copy of its text. */
export async function forgetQuotedMessage(
  ctx: MutationCtx,
  messageId: Id<'messages'>,
) {
  const replies = await ctx.db
    .query('messages')
    .withIndex('by_replyTarget', (q) => q.eq('replyTo.target.id', messageId))
    .collect()

  for (const reply of replies) {
    if (!reply.replyTo) continue
    const { sender, senderName } = reply.replyTo
    await ctx.db.patch(reply._id, {
      replyTo: { sender, ...(senderName && { senderName }), text: '' },
    })
  }
}

/** Points a copied reply at the copy of its quoted message, when there is one. */
export async function remapReplyQuote(
  ctx: QueryCtx,
  quote: ReplyQuote | undefined,
  copiedIds: Map<Id<'messages'>, Id<'messages'>>,
): Promise<ReplyQuote | undefined> {
  if (!quote) return undefined

  const { target, ...detached } = quote
  const copyId = target && copiedIds.get(target.id)
  const copy = copyId && (await ctx.db.get(copyId))
  if (!copy) return detached

  return {
    ...detached,
    target: { id: copy._id, creationTime: copy._creationTime },
  }
}

/** Reads the quoted text from the first segment that has any. */
async function quotedText(ctx: QueryCtx, message: Doc<'messages'>) {
  const answerLast = message.role === 'assistant'
  const segments = queryMessageSegments(
    ctx,
    message._id,
    message.selectedVersion,
  ).order(answerLast ? 'desc' : 'asc')

  for await (const segment of segments) {
    const text = quotableText(segment.parts, answerLast)
    if (text) return text
  }
  return ''
}
