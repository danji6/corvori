import { type Infer, v } from 'convex/values'

export const attachmentSendKey = v.object({
  sessionId: v.id('sessions'),
  clientSendId: v.string(),
})

export const beginAttachmentSendArgs = v.object({
  ...attachmentSendKey.fields,
  occurrenceIds: v.array(v.string()),
})

export const attachmentSendSlot = v.object({
  id: v.id('attachmentSends'),
  occurrenceId: v.string(),
})

export const attachmentSendSchema = v.object({
  ...attachmentSendKey.fields,
  senderId: v.id('users'),
  expiresAt: v.number(),
  slots: v.array(
    v.object({
      occurrenceId: v.string(),
      attachmentId: v.optional(v.id('attachments')),
    }),
  ),
})

export type AttachmentSendKey = Infer<typeof attachmentSendKey>
export type BeginAttachmentSendArgs = Infer<typeof beginAttachmentSendArgs>
export type AttachmentSendSlot = Infer<typeof attachmentSendSlot>
