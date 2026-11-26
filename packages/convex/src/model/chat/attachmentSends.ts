import type { Doc, Id } from '../../_generated/dataModel'
import type { MutationCtx } from '../../_generated/server'
import { error } from '../../errors'
import type { AuthMutationCtx } from '../../functions'
import type { BeginAttachmentSendArgs } from '../../validators/attachmentSends'
import { removeAttachment } from '../attachments/files'
import * as Memberships from '../session/memberships'
import { wakeAttachmentTurn } from '../stream/execution'
import {
  ATTACHMENT_SEND_LEASE_MS,
  CLIENT_SEND_ID,
  findAttachmentSend,
  findDeliveredSend,
  ownsDeliveredSend,
} from './attachmentSendRecords'
import { slowModeRemainingMs } from './send'

export async function beginAttachmentSend(
  ctx: AuthMutationCtx,
  args: BeginAttachmentSendArgs,
) {
  const { sessionId, clientSendId, occurrenceIds } = args
  const { session, membership } = await Memberships.requireMember(
    ctx,
    sessionId,
    ctx.userId,
  )
  Memberships.requireEnabled(session)
  assertSendIdentifiers(clientSendId, occurrenceIds)

  const delivered = await findDeliveredSend(ctx, args)
  if (delivered) {
    if (!ownsDeliveredSend(delivered, ctx.userId))
      error('Client send ID is already in use', 409)
    return { messageId: delivered._id }
  }

  const now = Date.now()
  const existing = await findAttachmentSend(ctx, args)
  if (existing) {
    if (existing.senderId !== ctx.userId)
      error('Client send ID is already in use', 409)
    if (existing.expiresAt > now) {
      const sameFiles =
        existing.slots.length === occurrenceIds.length &&
        existing.slots.every(
          (slot, index) => slot.occurrenceId === occurrenceIds[index],
        )
      if (!sameFiles) {
        error('Attachment list changed', 409)
      }
      return { pendingId: existing._id }
    }
    await removePendingSend(ctx, existing)
  }

  const remainingMs = slowModeRemainingMs(
    membership,
    session.settings?.slowModeMs,
    now,
  )
  if (remainingMs > 0)
    error(`Slow mode: wait ${Math.ceil(remainingMs / 1000)}s`, 429)

  const pendingId = await ctx.db.insert('attachmentSends', {
    sessionId,
    clientSendId,
    senderId: ctx.userId,
    expiresAt: now + ATTACHMENT_SEND_LEASE_MS,
    slots: occurrenceIds.map((occurrenceId) => ({ occurrenceId })),
  })

  await ctx.db.patch(membership._id, { lastSendAt: now })
  await keepClaimedTurnBoundary(ctx, sessionId)

  return { pendingId }
}

async function keepClaimedTurnBoundary(
  ctx: MutationCtx,
  sessionId: Id<'sessions'>,
) {
  const stream = await Memberships.getActiveStream(ctx, sessionId)
  if (!stream) return

  const { command } = stream
  const readsLiveHistory =
    command.kind === 'impersonate' ||
    (command.kind === 'invoke' && !command.preserveContextBoundary)
  if (!readsLiveHistory) return
  if (!stream.state.processingMessageId || stream.deferInterjections) return

  await ctx.db.patch(stream._id, {
    deferInterjections: true,
    contextBoundaryCreationTime: stream.contextBoundaryCreationTime ?? 0,
  })
}

function assertSendIdentifiers(clientSendId: string, occurrenceIds: string[]) {
  if (!CLIENT_SEND_ID.test(clientSendId)) error('Invalid client send ID', 400)
  const unique = new Set(occurrenceIds)
  if (
    !occurrenceIds.length ||
    unique.size !== occurrenceIds.length ||
    occurrenceIds.some((id) => !id || id.length > 128)
  ) {
    error('Invalid attachment list', 400)
  }
}

export async function renewAttachmentSend(
  ctx: AuthMutationCtx,
  { id }: { id: Id<'attachmentSends'> },
) {
  const now = Date.now()
  const send = await ctx.db.get(id)
  if (send?.senderId !== ctx.userId || send.expiresAt <= now) return false

  const member = await Memberships.getMember(ctx, send.sessionId, ctx.userId)
  if (!member || member.session.settings?.disabled) return false

  const expiresAt = now + ATTACHMENT_SEND_LEASE_MS
  await ctx.db.patch(id, { expiresAt })
  const stream = await Memberships.getActiveStream(ctx, send.sessionId)

  if (
    stream?.state.phase === 'awaiting_attachments' &&
    stream.leaseExpiresAt < expiresAt + ATTACHMENT_SEND_LEASE_MS
  ) {
    await ctx.db.patch(stream._id, {
      leaseExpiresAt: expiresAt + ATTACHMENT_SEND_LEASE_MS,
    })
  }

  return true
}

export async function discardAttachmentSend(
  ctx: AuthMutationCtx,
  { id }: { id: Id<'attachmentSends'> },
) {
  const send = await ctx.db.get(id)
  if (!send) return
  if (send.senderId !== ctx.userId) error('Attachment send is unavailable', 404)
  await removePendingSend(ctx, send)
  await wakeAttachmentTurn(ctx, send.sessionId)
}

export async function sweepAttachmentSends(ctx: MutationCtx) {
  const expired = await ctx.db
    .query('attachmentSends')
    .withIndex('by_expiresAt', (q) => q.lte('expiresAt', Date.now()))
    .take(50)
  const sessions = new Set<Id<'sessions'>>()

  for (const send of expired) {
    await removePendingSend(ctx, send)
    sessions.add(send.sessionId)
  }
  for (const sessionId of sessions) {
    await wakeAttachmentTurn(ctx, sessionId)
  }
}

async function removePendingSend(
  ctx: MutationCtx,
  send: Doc<'attachmentSends'>,
) {
  for (const { attachmentId } of send.slots) {
    if (!attachmentId) continue
    const attachment = await ctx.db.get(attachmentId)
    if (attachment?.pendingSendId === send._id && !attachment.messageId) {
      await removeAttachment(ctx, attachment)
    }
  }
  await ctx.db.delete(send._id)
}
