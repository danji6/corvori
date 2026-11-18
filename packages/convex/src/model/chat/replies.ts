import { clipReplyQuote, quotableText } from '@cv/core/reply-quote'

import type { Doc, Id } from '../../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../../_generated/server'
import { error } from '../../errors'
import type { PartAddress, ReplyQuote } from '../../types'
import {
  getSegmentRow,
  invalidateCompletedHistory,
  listSelectedSegments,
  queryMessageSegments,
} from '../messageContents'

/** Snapshots the message a reply quotes, rejecting ones that can't be quoted. */
export async function quoteMessage(
  ctx: QueryCtx,
  sessionId: Id<'sessions'>,
  messageId: Id<'messages'>,
  part?: PartAddress,
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
    target: {
      id: message._id,
      creationTime: message._creationTime,
      ...(part && { part }),
    },
    sender: message.sender,
    ...(message.senderName && { senderName: message.senderName }),
    text: clipReplyQuote(
      part
        ? await quotedPartText(ctx, message, part)
        : await quotedText(ctx, message),
    ),
  }
}

/** Reads the selected text block without falling back to a different block. */
async function quotedPartText(
  ctx: QueryCtx,
  message: Doc<'messages'>,
  address: PartAddress,
) {
  const indicesAreNonnegativeIntegers = [
    address.segmentIndex,
    address.partIndex,
  ].every((index) => Number.isSafeInteger(index) && index >= 0)
  if (!indicesAreNonnegativeIntegers) error('Invalid quoted text block')

  const segment = await getSegmentRow(
    ctx,
    message._id,
    message.selectedVersion,
    address.segmentIndex,
  )
  const text = quotableText([segment?.parts[address.partIndex]], false)
  if (!text) error('Quoted text block not found', 404)
  return text
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
    await invalidateCompletedHistory(ctx, reply)
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

  const part =
    target?.part && (await remapQuotedPart(ctx, target.id, copy, target.part))
  return {
    ...detached,
    target: {
      id: copy._id,
      creationTime: copy._creationTime,
      ...(part && { part }),
    },
  }
}

/** Keeps the same part when duplication packs it into different segments. */
async function remapQuotedPart(
  ctx: QueryCtx,
  originalId: Id<'messages'>,
  copy: Doc<'messages'>,
  address: PartAddress,
): Promise<PartAddress | undefined> {
  const original = await ctx.db.get(originalId)
  if (!original) return undefined
  const segments = await listSelectedSegments(ctx, original)
  const index = segments.findIndex(
    (row) => row.segmentIndex === address.segmentIndex,
  )
  if (index < 0) return undefined

  let partIndex = segments
    .slice(0, index)
    .reduce((count, row) => count + row.parts.length, address.partIndex)
  for (const segment of await listSelectedSegments(ctx, copy)) {
    if (partIndex < segment.parts.length) {
      return { segmentIndex: segment.segmentIndex, partIndex }
    }
    partIndex -= segment.parts.length
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
