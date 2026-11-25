import {
  attachmentReplyCount,
  attachmentReplyLabel,
  clipReplyQuote,
  quotableText,
} from '@cv/core/reply-quote'

import type { Doc, Id } from '../../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../../_generated/server'
import { error } from '../../errors'
import type { AuthQueryCtx } from '../../functions'
import type { PartAddress, ReplyQuote } from '../../validators/messages'
import {
  getSegmentRow,
  invalidateCompletedHistory,
  listSelectedSegments,
  queryMessageSegments,
} from '../messageContents'
import { hasMessageScript } from '../messages'
import { modelSegmentParts } from '../promptEvaluation/messageParts'
import { getMember } from '../session/memberships'

/** Finds the first file in the original message, even outside the transcript window. */
export async function getReplyAttachment(
  ctx: AuthQueryCtx,
  { messageId }: { messageId: Id<'messages'> },
) {
  const message = await ctx.db.get(messageId)
  if (!message || message.hidden || message.type) return null
  if (message.status === 'processing') return null

  const member = await getMember(ctx, message.sessionId, ctx.userId)
  if (!member) return null

  const segments = queryMessageSegments(ctx, messageId, message.selectedVersion)
  for await (const segment of segments) {
    for (const part of segment.parts) {
      const file = replyFilePart(part)
      if (file) return file
    }
  }
  return null
}

function replyFilePart(part: unknown) {
  if (typeof part !== 'object' || part === null) return
  const { type, url, mediaType, filename, attachmentId } = part as Record<
    string,
    unknown
  >
  if (type !== 'file' || typeof url !== 'string') return

  return {
    type: 'file' as const,
    url,
    mediaType:
      typeof mediaType === 'string' ? mediaType : 'application/octet-stream',
    ...(typeof filename === 'string' && { filename }),
    ...(typeof attachmentId === 'string' && { attachmentId }),
  }
}

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

  const text = clipReplyQuote(
    part
      ? await quotedPartText(ctx, message, part)
      : await quotedText(ctx, message),
  )
  return {
    target: {
      id: message._id,
      creationTime: message._creationTime,
      ...(part && { part }),
    },
    sender: message.sender,
    senderName: message.senderName,
    text,
    ...(hasMessageScript(text) && { rendered: true }),
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
  const selectedPart = segment?.parts[address.partIndex]
  const safe = segment && (await modelSegmentParts(ctx, segment))
  const text = safe?.includes(selectedPart)
    ? quotableText([selectedPart], false)
    : ''
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
      replyTo: { sender, senderName, text: '' },
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

/** Reads the first quotable text or labels an attachment-only message. */
async function quotedText(ctx: QueryCtx, message: Doc<'messages'>) {
  const answerLast = message.role === 'assistant'
  const segments = queryMessageSegments(
    ctx,
    message._id,
    message.selectedVersion,
  ).order(answerLast ? 'desc' : 'asc')

  const partsBySegment: unknown[][] = []
  for await (const segment of segments) {
    const text = quotableText(await modelSegmentParts(ctx, segment), answerLast)
    if (text) return text
    partsBySegment.push(segment.parts)
  }
  return attachmentReplyLabel(attachmentReplyCount(partsBySegment))
}
