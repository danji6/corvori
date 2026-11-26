import {
  isAttachmentCompanionContent,
  messageFileKey,
} from '@cv/core/attachments'

import type { Doc, Id } from '../../_generated/dataModel'
import { error } from '../../errors'
import type { AuthMutationCtx } from '../../functions'
import { minRole } from '../../lib/roles'
import type {
  DeleteMessageAttachmentArgs,
  DeleteMessagePartsArgs,
  EditMessageArgs,
  EditMessagePartArgs,
} from '../../validators/messages'
import * as Attachments from '../attachments/files'
import { deleteLinkPreviewImages } from '../linkPreviews/records'
import {
  allVersionParts,
  deleteVersions,
  getSegmentRow,
  invalidateCompletedHistory,
  listSelectedSegments,
  replaceSelectedContent,
  setSegmentParts,
} from '../messageContents'
import { releaseEvaluation } from '../promptEvaluation/records'
import { reserveSegmentEvaluation } from '../promptEvaluation/reserve'
import { cancelByMessage } from '../scheduledEvents'
import * as Memberships from '../session/memberships'
import { refreshMessagePreviews } from '../session/messagePreviews'
import { removeDeliveriesForParts } from '../shell/outputDeliveries'
import { collectToolOutputStorageIds } from '../stream/toolOutput'
import { clearAnnouncedMode } from './notes'
import { forgetQuotedMessage } from './replies'

export async function editMessage(ctx: AuthMutationCtx, args: EditMessageArgs) {
  const { message } = await requireMessageMutation(ctx, args.messageId)
  requireEditable(message)
  if (args.content === undefined) {
    if (!args.removeReplyQuote) error('Message content is required', 400)
    if (await clearReplyQuote(ctx, message))
      await invalidateCompletedHistory(ctx, message)
    return
  }

  const parts = [{ type: 'text', text: args.content }]

  const segments = await listSelectedSegments(ctx, message)
  const removed = segments.flatMap((segment) => segment.parts)
  await deleteToolOutput(ctx, removed)
  await replaceSelectedContent(ctx, message, parts)
  if (args.removeReplyQuote) await clearReplyQuote(ctx, message)
  await removeUnreferencedAttachmentsForParts(ctx, message._id, removed)

  await reserveSegmentEvaluation(ctx, {
    messageId: message._id,
    invokerId: ctx.userId,
    parts,
    version: message.selectedVersion,
    segmentIndex: 0,
  })
}

export async function editMessagePart(
  ctx: AuthMutationCtx,
  args: EditMessagePartArgs,
) {
  const { message } = await requireMessageMutation(ctx, args.messageId)
  requireEditable(message)
  const row = await getSegmentRow(
    ctx,
    message._id,
    message.selectedVersion,
    args.segmentIndex,
  )
  if (!row) error('Not found', 404)

  const part = row.parts[args.partIndex]
  if (!isEditablePart(part)) error('Part is not editable', 400)

  const parts = [...row.parts]
  const {
    evaluationRendered: _rendered,
    evaluationPending: _pending,
    ...edited
  } = part
  parts[args.partIndex] = { ...edited, text: args.text }

  await setSegmentParts(ctx, message, row, parts)
  if (args.removeReplyQuote) await clearReplyQuote(ctx, message)

  await reserveSegmentEvaluation(ctx, {
    messageId: message._id,
    invokerId: ctx.userId,
    parts,
    version: message.selectedVersion,
    segmentIndex: args.segmentIndex,
  })
}

/** Clears the quote metadata. Content writes already invalidate history. */
async function clearReplyQuote(ctx: AuthMutationCtx, message: Doc<'messages'>) {
  if (!message.replyTo) return false
  await ctx.db.patch(message._id, { replyTo: undefined })
  return true
}

/** @returns true when removing the parts deleted the whole message. */
export async function deleteMessageParts(
  ctx: AuthMutationCtx,
  args: DeleteMessagePartsArgs,
): Promise<boolean> {
  const { message } = await requireMessageMutation(ctx, args.messageId)
  const segments = await listSelectedSegments(ctx, message)
  return deleteSelectedParts(ctx, message, segments, partRemovalFilter(args))
}

/** Removes exactly the file occurrence selected in the transcript. */
export async function deleteMessageAttachment(
  ctx: AuthMutationCtx,
  args: DeleteMessageAttachmentArgs,
): Promise<boolean> {
  const { message } = await requireMessageMutation(ctx, args.messageId)
  const { segmentIndex, partIndex } = args.address
  const segments = await listSelectedSegments(ctx, message)
  const segment = segments.find((row) => row.segmentIndex === segmentIndex)
  const fileKey = segment && messageFileKey(segment.parts[partIndex])

  const selectionMatches =
    message.selectedVersion === args.expectedVersion &&
    segment?.parts.length === args.expectedSegmentPartCount &&
    fileKey !== undefined &&
    fileKey === args.expectedFileKey
  if (!selectionMatches)
    error('This attachment has changed. Reopen the menu and try again.', 409)

  const selected: PartRemovalFilter = (segment, part) =>
    segment === segmentIndex && part === partIndex
  const hasOtherContent = segments.some((row) =>
    row.parts.some(
      (part, index) =>
        !selected(row.segmentIndex, index) &&
        isAttachmentCompanionContent(part),
    ),
  )
  return deleteSelectedParts(
    ctx,
    message,
    segments,
    hasOtherContent ? selected : () => true,
  )
}

type PartRemovalFilter = (segmentIndex: number, partIndex: number) => boolean

function partRemovalFilter(args: DeleteMessagePartsArgs): PartRemovalFilter {
  const explicit = new Map<number, Set<number>>()
  for (const address of args.addresses) {
    const indices = explicit.get(address.segmentIndex) ?? new Set<number>()
    indices.add(address.partIndex)
    explicit.set(address.segmentIndex, indices)
  }

  const from = args.from
  return (segmentIndex, partIndex) => {
    if (explicit.get(segmentIndex)?.has(partIndex)) return true
    if (!from) return false
    return (
      segmentIndex > from.segmentIndex ||
      (segmentIndex === from.segmentIndex && partIndex >= from.partIndex)
    )
  }
}

async function deleteSelectedParts(
  ctx: AuthMutationCtx,
  message: Doc<'messages'>,
  segments: Doc<'messageContents'>[],
  shouldRemove: PartRemovalFilter,
): Promise<boolean> {
  const removed: unknown[] = []
  const plans = segments.map((row) => {
    const kept = row.parts.filter(
      (_, index) => !shouldRemove(row.segmentIndex, index),
    )
    removed.push(
      ...row.parts.filter((_, index) => shouldRemove(row.segmentIndex, index)),
    )
    return { row, kept }
  })

  if (plans.every(({ kept }) => kept.length === 0)) {
    await deleteMessageDoc(ctx, message)
    await refreshMessagePreviews(ctx, message.sessionId)
    return true
  }

  await deleteToolOutput(ctx, removed)

  await removeDeliveriesForParts(ctx, {
    messageId: message._id,
    version: message.selectedVersion,
    parts: removed,
  })

  for (const { row, kept } of plans) {
    if (kept.length === row.parts.length) continue
    if (kept.length === 0) {
      // Emptied segments are dropped without renumbering the remaining
      // ones (gaps keep later part addresses stable)
      await releaseEvaluation(ctx, row.promptEvaluationId)
      await deleteLinkPreviewImages(ctx, row)
      await ctx.db.delete(row._id)
      await invalidateCompletedHistory(ctx, message)
    } else {
      await setSegmentParts(ctx, message, row, kept)
    }
  }

  await removeUnreferencedAttachmentsForParts(ctx, message._id, removed)

  return false
}

export async function deleteMessage(
  ctx: AuthMutationCtx,
  args: { messageId: Id<'messages'> },
) {
  const { message } = await requireMessageMutation(ctx, args.messageId, {
    allowResetCancellation: true,
  })
  await deleteMessageDoc(ctx, message)
  await forgetDeletedModeNotes(ctx, message.sessionId, [message])
  await refreshMessagePreviews(ctx, message.sessionId)
}

export async function deleteMessagesFrom(
  ctx: AuthMutationCtx,
  args: { messageId: Id<'messages'> },
) {
  const { message, session } = await requireMessageMutation(ctx, args.messageId)

  if (await Memberships.getActiveStream(ctx, message.sessionId)) {
    error('Session is busy', 409)
  }

  const range = await ctx.db
    .query('messages')
    .withIndex('by_sessionId_position', (q) =>
      q.eq('sessionId', message.sessionId).gte('position', message.position),
    )
    .collect()

  assertRangeDeletable(ctx, range, session)

  for (const doc of range) {
    await deleteMessageDoc(ctx, doc)
  }
  await forgetDeletedModeNotes(ctx, message.sessionId, range)
  await refreshMessagePreviews(ctx, message.sessionId)
}

async function forgetDeletedModeNotes(
  ctx: AuthMutationCtx,
  sessionId: Id<'sessions'>,
  deleted: Doc<'messages'>[],
) {
  if (deleted.some((doc) => doc.type === 'mode')) {
    await clearAnnouncedMode(ctx, sessionId)
  }
}

export function assertRangeDeletable(
  ctx: Pick<AuthMutationCtx, 'userId' | 'role'>,
  range: Doc<'messages'>[],
  session: Doc<'sessions'>,
) {
  for (const message of range) {
    if (message.status === 'processing') {
      error('Message is being processed', 409)
    }
    requireDeletableSender(ctx, message, session)
  }
}

async function deleteMessageDoc(
  ctx: AuthMutationCtx,
  message: Doc<'messages'>,
) {
  await cancelByMessage(ctx, message._id)

  const attachments = await ctx.db
    .query('attachments')
    .withIndex('by_messageId', (q) => q.eq('messageId', message._id))
    .collect()

  for (const attachment of attachments) {
    await Attachments.removeAttachment(ctx, attachment)
  }

  await invalidateCompletedHistory(ctx, message)
  await deleteVersions(ctx, message._id)
  await forgetQuotedMessage(ctx, message._id)
  await ctx.db.delete(message._id)
}

async function deleteToolOutput(ctx: AuthMutationCtx, parts: unknown[]) {
  for (const storageId of collectToolOutputStorageIds(parts)) {
    await ctx.storage.delete(storageId).catch(() => {})
  }
}

async function removeUnreferencedAttachmentsForParts(
  ctx: AuthMutationCtx,
  messageId: Id<'messages'>,
  removedParts: unknown[],
) {
  const candidates = Attachments.unreferencedAttachmentIds(
    removedParts,
    await allVersionParts(ctx, messageId),
  )
  if (candidates.size === 0) return

  for (const attachmentId of candidates) {
    const attachment = await ctx.db.get(attachmentId as Id<'attachments'>)
    if (attachment && attachment.messageId === messageId) {
      await Attachments.removeAttachment(ctx, attachment)
    }
  }
}

function isEditablePart(part: unknown): part is {
  type: 'text' | 'reasoning'
  text: string
  evaluationRendered?: true
  evaluationPending?: true
} {
  return (
    typeof part === 'object' &&
    part !== null &&
    'type' in part &&
    (part.type === 'text' || part.type === 'reasoning')
  )
}

async function requireMessageMutation(
  ctx: AuthMutationCtx,
  messageId: Id<'messages'>,
  options?: { allowResetCancellation?: boolean },
) {
  const message = await ctx.db.get(messageId)
  if (!message) error('Not found', 404)

  const { session } = await Memberships.requireMember(
    ctx,
    message.sessionId,
    ctx.userId,
  )

  if (!options?.allowResetCancellation || !isQueuedContextReset(message)) {
    await Memberships.requireNonBlockingStream(ctx, message.sessionId)
  }

  if (session.settings?.disabled && session.ownerId !== ctx.userId) {
    error('Session is disabled', 409)
  }

  if (message.status === 'processing') {
    error('Message is being processed', 409)
  }

  requireDeletableSender(ctx, message, session)

  return { message, session }
}

function isQueuedContextReset({ type, extra }: Doc<'messages'>) {
  return (
    type === 'command' &&
    extra &&
    'status' in extra &&
    extra.name === 'new' &&
    extra.status === 'queued'
  )
}

type Caller = Pick<AuthMutationCtx, 'userId' | 'role'>

/** Session owners and moderators may remove anyone's messages. */
function canModerate(caller: Caller, session: Doc<'sessions'>) {
  return session.ownerId === caller.userId || minRole(caller.role, 'moderator')
}

function requireDeletableSender(
  ctx: Caller,
  message: Doc<'messages'>,
  session: Doc<'sessions'>,
) {
  if (canModerate(ctx, session)) return

  // Join/leave notices are a session record, not their participant's message
  if (message.type === 'presence' || message.sender.type === 'archived') {
    error('Forbidden', 403)
  }

  const othersMessage =
    message.sender.type === 'user' && message.sender.id !== ctx.userId
  if (othersMessage) error('Forbidden', 403)
}

function requireEditable(message: Doc<'messages'>) {
  if (message.type === 'presence') error('Message is not editable', 400)
}
