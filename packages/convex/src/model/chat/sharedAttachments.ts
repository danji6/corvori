import { attachmentShare } from '@cv/core/attachments'
import {
  type MarkdownLink,
  markdownHttpLinks,
  removeMarkdownLinks,
} from '@cv/core/utils/markdown-links'

import type { Doc } from '../../_generated/dataModel'
import type { QueryCtx } from '../../_generated/server'

type ShareContext = Pick<QueryCtx, 'db' | 'storage'>
type ResolvedShare = { file: Doc<'attachmentFiles'>; url: string }

/** Resolves each distinct public link using its file record hint. */
export async function resolveAttachmentShares(
  ctx: ShareContext,
  content: string,
  matches = new Map<string, ResolvedShare | null>(),
) {
  const files = new Map<string, Doc<'attachmentFiles'>>()
  const removed: MarkdownLink[] = []
  if (!content.includes('#attachment=')) return { content, files }

  for (const link of markdownHttpLinks(content)) {
    if (!matches.has(link.url)) {
      matches.set(link.url, await resolveShare(ctx, link.url))
    }
    const share = matches.get(link.url)
    if (!share) continue
    files.set(share.file._id, share.file)
    removed.push(link)
  }

  return { content: removeMarkdownLinks(content, removed), files }
}

export async function resolveShare(ctx: ShareContext, value: string) {
  const share = attachmentShare(value)
  if (!share) return null
  const id = ctx.db.normalizeId('attachmentFiles', share.fileId)
  if (!id) return null

  const file = await ctx.db.get(id)
  if (!file) return null
  const url = await ctx.storage.getUrl(file.storageId)
  return url && new URL(url).href === share.url ? { file, url } : null
}

/** Gets composer previews using the same public URL verification as Send. */
export async function previewShares(
  ctx: ShareContext,
  { urls }: { urls: string[] },
) {
  return Promise.all(
    [...new Set(urls)].map(async (shareUrl) => {
      const share = await resolveShare(ctx, shareUrl)
      if (!share) return null
      const { file, url } = share
      return {
        fileId: file._id,
        filename: file.filename,
        mediaType: file.mediaType,
        byteLength: file.byteLength,
        ...(file.imageDimensions && { imageDimensions: file.imageDimensions }),
        previewUrl: file.previewStorageId
          ? await ctx.storage.getUrl(file.previewStorageId)
          : null,
        shareUrl,
        url,
      }
    }),
  )
}
