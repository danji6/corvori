import type { Doc, Id } from '../../_generated/dataModel'
import type { QueryCtx } from '../../_generated/server'
import { error } from '../../errors'
import type { AttachmentSendKey } from '../../validators/attachmentSends'

export const ATTACHMENT_SEND_LEASE_MS = 5 * 60_000

export function findAttachmentSend(ctx: QueryCtx, key: AttachmentSendKey) {
  return ctx.db
    .query('attachmentSends')
    .withIndex('by_sessionId_clientSendId', (q) =>
      q.eq('sessionId', key.sessionId).eq('clientSendId', key.clientSendId),
    )
    .unique()
}

export function latestAttachmentSend(ctx: QueryCtx, sessionId: Id<'sessions'>) {
  return ctx.db
    .query('attachmentSends')
    .withIndex('by_sessionId_expiresAt', (q) =>
      q.eq('sessionId', sessionId).gt('expiresAt', Date.now()),
    )
    .order('desc')
    .first()
}

export function findDeliveredSend(ctx: QueryCtx, key: AttachmentSendKey) {
  return ctx.db
    .query('messages')
    .withIndex('by_sessionId_clientSendId', (q) =>
      q.eq('sessionId', key.sessionId).eq('clientSendId', key.clientSendId),
    )
    .first()
}

/** Returns a live reservation only to its original sender. */
export async function requireAttachmentSend(
  ctx: QueryCtx,
  id: Id<'attachmentSends'>,
  sessionId: Id<'sessions'>,
  senderId: Id<'users'>,
) {
  const send = await ctx.db.get(id)
  if (send?.sessionId !== sessionId || send.senderId !== senderId) {
    error('Attachment send is unavailable', 404)
  }
  if (send.expiresAt <= Date.now()) error('Attachment send expired', 409)
  return send
}

export function ownsDeliveredSend(
  message: Doc<'messages'>,
  senderId: Id<'users'>,
) {
  return (
    message.role === 'user' &&
    message.sender.type === 'user' &&
    message.sender.id === senderId
  )
}

export const CLIENT_SEND_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
