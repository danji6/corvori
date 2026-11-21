import { attachmentShareUrl } from '@cv/core/attachments'

import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { error } from '../errors'
import type { AuthMutationCtx, AuthQueryCtx } from '../functions'
import type {
  AttachmentImageDimensions,
  ConfirmAttachmentWithDimensionsArgs,
  CreateGeneratedAttachmentArgs,
  StreamExecutionArgs,
} from '../types'
import { allocateAttachmentName } from './attachmentNames'
import { allVersionParts } from './messageContents'
import { getMember, requireEnabled, requireMember } from './session/memberships'
import { ownsExecution } from './stream/execution'

const STAGED_ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1000

export async function generateUploadUrl(ctx: AuthMutationCtx) {
  return ctx.storage.generateUploadUrl()
}

export async function confirm(
  ctx: MutationCtx,
  args: ConfirmAttachmentWithDimensionsArgs,
  uploaderId: Id<'users'>,
) {
  const { imageDimensions, ...attachment } = args
  const { session } = await requireMember(ctx, args.sessionId, uploaderId)
  requireEnabled(session)
  const stored = await storeAttachment(ctx, {
    ...attachment,
    imageDimensions,
    uploaderId,
  })
  return stored.attachmentId
}

type CreateFileArgs = {
  storageId: Id<'_storage'>
  previewStorageId?: Id<'_storage'>
  filename: string
  mediaType: string
  imageDimensions?: AttachmentImageDimensions
}

async function createFile(ctx: MutationCtx, args: CreateFileArgs) {
  const metadata = await ctx.db.system.get('_storage', args.storageId)
  if (!metadata) error('Attachment data is no longer available', 404)

  const previewMetadata = args.previewStorageId
    ? await ctx.db.system.get('_storage', args.previewStorageId)
    : null
  if (args.previewStorageId && !previewMetadata)
    error('Attachment preview is no longer available', 404)

  return ctx.db.insert('attachmentFiles', {
    storageId: args.storageId,
    previewStorageId: args.previewStorageId,
    previewMediaType: previewMetadata?.contentType,
    imageDimensions: args.imageDimensions,
    filename: args.filename,
    mediaType: args.mediaType,
    byteLength: metadata.size,
  })
}

export async function getUrl(
  ctx: AuthQueryCtx,
  args: { attachmentId: Id<'attachments'> },
) {
  const attachment = await requireReadable(ctx, args.attachmentId)
  const file = await ctx.db.get(attachment.fileId)
  return file ? ctx.storage.getUrl(file.storageId) : null
}

export async function get(
  ctx: AuthQueryCtx,
  args: { attachmentId: Id<'attachments'> },
) {
  return requireReadable(ctx, args.attachmentId)
}

export async function _get(
  ctx: QueryCtx,
  { attachmentId }: { attachmentId: Id<'attachments'> },
) {
  const attachment = await ctx.db.get(attachmentId)
  if (!attachment) return null

  const file = await ctx.db.get(attachment.fileId)
  if (!file) return null

  return {
    storageId: file.storageId,
    previewStorageId: file.previewStorageId,
    previewMediaType: file.previewMediaType,
    mediaType: file.mediaType,
    filename: file.filename,
    byteLength: file.byteLength,
  }
}

export async function getToolFile(
  ctx: QueryCtx,
  args: StreamExecutionArgs & { attachmentId: string },
) {
  const stream = await ctx.db.get(args.streamId)
  if (!ownsExecution(stream, args)) return null

  const id = ctx.db.normalizeId('attachments', args.attachmentId)
  if (!id) return null
  const attachment = await ctx.db.get(id)
  if (attachment?.sessionId !== stream.sessionId) return null

  const member = await getMember(ctx, stream.sessionId, stream.invokedBy)
  if (!member) return null
  requireEnabled(member.session)
  return ctx.db.get(attachment.fileId)
}

export async function listBySession(
  ctx: AuthQueryCtx,
  { sessionId }: { sessionId: Id<'sessions'> },
) {
  await requireMember(ctx, sessionId, ctx.userId)
  return ctx.db
    .query('attachments')
    .withIndex('by_sessionId', (q) => q.eq('sessionId', sessionId))
    .collect()
}

export async function remove(
  ctx: AuthMutationCtx,
  { attachmentId }: { attachmentId: Id<'attachments'> },
) {
  const attachment = await ctx.db.get(attachmentId)
  if (!attachment) return
  const { session } = await requireMember(ctx, attachment.sessionId, ctx.userId)
  if (attachment.messageId) error('Delete the owning message instead', 409)
  if (attachment.uploaderId !== ctx.userId && session.ownerId !== ctx.userId) {
    error('Forbidden', 403)
  }
  await removeAttachment(ctx, attachment)
}

export async function getUrlMap(ctx: AuthQueryCtx, { ids }: { ids: string[] }) {
  const result: Record<
    string,
    {
      url: string
      previewUrl: string | null
      shareUrl: string
      byteLength: number | null
      imageDimensions?: AttachmentImageDimensions
      mediaType: string
      filename: string
      createdAt: number
    }
  > = {}
  for (const value of ids) {
    const id = ctx.db.normalizeId('attachments', value)
    if (!id) continue
    const attachment = await readableOrNull(ctx, id)
    if (!attachment) continue

    const file = await ctx.db.get(attachment.fileId)
    if (!file) continue

    const url = await ctx.storage.getUrl(file.storageId)
    const previewStorageId = file.previewStorageId
    const previewUrl = previewStorageId
      ? await ctx.storage.getUrl(previewStorageId)
      : url

    if (url)
      result[id] = {
        url,
        previewUrl,
        shareUrl: attachmentShareUrl(url, file._id),
        byteLength: file.byteLength,
        imageDimensions: file.imageDimensions,
        mediaType: file.mediaType,
        filename: file.filename,
        createdAt: attachment._creationTime,
      }
  }
  return result
}

export async function _createGenerated(
  ctx: MutationCtx,
  args: CreateGeneratedAttachmentArgs,
) {
  const stream = await ctx.db.get(args.streamId)
  if (!ownsExecution(stream, args)) {
    await ctx.storage.delete(args.storageId)
    return null
  }
  const { attachmentId, metadata } = await createGeneratedAttachment(ctx, args)
  return { attachmentId, filename: metadata.filename }
}

export async function createGeneratedAttachment(
  ctx: MutationCtx,
  args: CreateGeneratedAttachmentArgs,
) {
  const { generation: _generation, ...attachment } = args
  const { attachmentId, fileId } = await storeAttachment(ctx, attachment)
  return { attachmentId, metadata: (await ctx.db.get(fileId))! }
}

type NewAttachment = Omit<
  Doc<'attachments'>,
  '_id' | '_creationTime' | 'fileId'
> & { imageDimensions?: AttachmentImageDimensions }

async function storeAttachment(ctx: MutationCtx, args: NewAttachment) {
  const { imageDimensions, ...attachment } = args
  const filename = await allocateAttachmentName(ctx, attachment)
  const fileId = await createFile(ctx, {
    ...attachment,
    filename,
    imageDimensions,
  })
  const attachmentId = await ctx.db.insert('attachments', {
    ...attachment,
    filename,
    fileId,
  })
  return { attachmentId, fileId }
}

/** Creates a session attachment pointing to an existing file. */
export async function createReference(
  ctx: MutationCtx,
  args: {
    file: Doc<'attachmentFiles'>
    sessionId: Id<'sessions'>
    uploaderId: Id<'users'>
  },
) {
  const { file } = args
  const attachmentId = await ctx.db.insert('attachments', {
    fileId: file._id,
    storageId: file.storageId,
    previewStorageId: file.previewStorageId,
    uploaderId: args.uploaderId,
    sessionId: args.sessionId,
    filename: file.filename,
    mediaType: file.mediaType,
  })
  return (await ctx.db.get(attachmentId))!
}

/** Deletes generated files that didn't make it into the final message. */
export async function cleanUpGeneratedAttachments(
  ctx: MutationCtx,
  streamId: Id<'streams'>,
) {
  const rows = await ctx.db
    .query('attachments')
    .withIndex('by_streamId', (q) => q.eq('streamId', streamId))
    .collect()
  if (rows.length === 0) return

  const referencedByMessage = new Map<Id<'messages'>, Set<string>>()
  for (const row of rows) {
    if (!row.messageId || referencedByMessage.has(row.messageId)) continue
    referencedByMessage.set(
      row.messageId,
      referencedAttachmentIds(await allVersionParts(ctx, row.messageId)),
    )
  }

  for (const row of rows) {
    const referenced = row.messageId
      ? referencedByMessage.get(row.messageId)?.has(row._id)
      : false
    if (referenced) {
      await ctx.db.patch(row._id, { streamId: undefined })
    } else {
      await removeAttachment(ctx, row)
    }
  }
}

export async function pruneOrphans(ctx: MutationCtx) {
  const cutoff = Date.now() - STAGED_ATTACHMENT_TTL_MS

  // Staged uploads that were never linked to a message
  const staged = await ctx.db
    .query('attachments')
    .withIndex('by_messageId', (q) => q.eq('messageId', undefined))
    .collect()

  for (const attachment of staged) {
    if (attachment._creationTime < cutoff)
      await removeAttachment(ctx, attachment)
  }

  // AI-generated files whose stream ended without running its own cleanup
  const generated = await ctx.db
    .query('attachments')
    // `undefined` sorts below every id, so this range is "streamId is set"
    .withIndex('by_streamId', (q) => q.gt('streamId', undefined))
    .collect()

  for (const attachment of generated) {
    if (attachment._creationTime >= cutoff || !attachment.messageId) continue
    if (await ctx.db.get(attachment.streamId!)) continue

    const referenced = referencedAttachmentIds(
      await allVersionParts(ctx, attachment.messageId),
    ).has(attachment._id)

    // Untag what survived, so it leaves the candidate set for good
    if (referenced) await ctx.db.patch(attachment._id, { streamId: undefined })
    else await removeAttachment(ctx, attachment)
  }
}

/** Attachment ids referenced by `file` parts, for copy/cleanup walks. */
export function referencedAttachmentIds(parts: unknown[]): Set<string> {
  const ids = new Set<string>()
  for (const part of parts) {
    if (
      typeof part === 'object' &&
      part !== null &&
      (part as { type?: unknown }).type === 'file' &&
      typeof (part as { attachmentId?: unknown }).attachmentId === 'string'
    ) {
      ids.add((part as { attachmentId: string }).attachmentId)
    }
  }
  return ids
}

/** Finds removed attachment ids no remaining message version references. */
export function unreferencedAttachmentIds(
  removedParts: unknown[],
  retainedParts: unknown[],
): Set<string> {
  const retained = referencedAttachmentIds(retainedParts)
  return new Set(
    [...referencedAttachmentIds(removedParts)].filter(
      (attachmentId) => !retained.has(attachmentId),
    ),
  )
}

/** Rewrites each part's `attachmentId` through the old->new id map. */
export function remapPartAttachmentIds(
  parts: unknown[],
  map: Map<Id<'attachments'>, Id<'attachments'>>,
): unknown[] {
  return parts.map((part) => {
    if (typeof part !== 'object' || part === null) return part
    const record = part as Record<string, unknown>
    if (typeof record.attachmentId !== 'string') return part
    const mapped = map.get(record.attachmentId as Id<'attachments'>)
    return mapped ? { ...record, attachmentId: mapped } : part
  })
}

export async function removeAttachment(
  ctx: MutationCtx,
  attachment: {
    _id: Id<'attachments'>
    fileId: Id<'attachmentFiles'>
  },
) {
  const fileId = attachment.fileId
  await ctx.db.delete(attachment._id)

  const remaining = await ctx.db
    .query('attachments')
    .withIndex('by_fileId', (q) => q.eq('fileId', fileId))
    .first()
  if (remaining) return

  const file = await ctx.db.get(fileId)
  if (!file) return

  await ctx.storage.delete(file.storageId).catch(() => {})
  if (file.previewStorageId) {
    await ctx.storage.delete(file.previewStorageId).catch(() => {})
  }
  await ctx.db.delete(fileId)
}

async function requireReadable(
  ctx: AuthQueryCtx,
  attachmentId: Id<'attachments'>,
) {
  const attachment = await ctx.db.get(attachmentId)
  if (!attachment) error('Not found', 404)
  await requireMember(ctx, attachment.sessionId, ctx.userId)
  return attachment
}

async function readableOrNull(
  ctx: AuthQueryCtx,
  attachmentId: Id<'attachments'>,
) {
  const attachment = await ctx.db.get(attachmentId)
  if (!attachment) return null
  const member = await getMember(ctx, attachment.sessionId, ctx.userId)
  return member ? attachment : null
}
