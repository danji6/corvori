import {
  ATTACH_FILE_TOOL_NAME,
  COPY_ATTACHMENT_TOOL_NAME,
} from '@cv/core/const'
import { v } from 'convex/values'

import { streamExecutionArgsValidator } from './streams'

export const attachmentTransferKind = v.union(
  v.literal(COPY_ATTACHMENT_TOOL_NAME),
  v.literal(ATTACH_FILE_TOOL_NAME),
)

export const attachmentTransferCall = v.object({
  ...streamExecutionArgsValidator.fields,
  callId: v.string(),
  kind: attachmentTransferKind,
  request: v.string(),
  path: v.optional(v.string()),
})

export const attachmentTransferResult = v.object({
  reference: v.string(),
  path: v.optional(v.string()),
  attachmentId: v.optional(v.id('attachments')),
  filename: v.string(),
  mediaType: v.string(),
  byteLength: v.number(),
})

export const attachmentTransferSchema = v.object({
  ...attachmentTransferCall.fields,
  sessionId: v.id('sessions'),
  rootId: v.id('sessions'),
  contentId: v.id('messageContents'),
  result: v.optional(attachmentTransferResult),
  expiresAt: v.number(),
  cleaned: v.optional(v.boolean()),
})

export const advanceCopyPathArgs = v.object({
  ...streamExecutionArgsValidator.fields,
  id: v.id('attachmentTransfers'),
  previousPath: v.string(),
  nextPath: v.string(),
})
