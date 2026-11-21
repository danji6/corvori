'use node'

import { v } from 'convex/values'

import { internal } from '../_generated/api'
import type { Id } from '../_generated/dataModel'
import { action } from '../_generated/server'
import { getSubject } from '../functions'
import type { AttachmentImageDimensions } from '../types'
import { confirmAttachmentArgsValidator } from '../validators/attachments'

type ConfirmedImage = {
  id: Id<'attachments'>
  imageDimensions?: AttachmentImageDimensions
}

export const confirmImage = action({
  args: confirmAttachmentArgsValidator.fields,
  handler: async (ctx, args): Promise<ConfirmedImage> => {
    const subject = await getSubject(ctx)
    await ctx.runQuery(internal.sessions._getMemberWorkspaceContext, {
      sessionId: args.sessionId,
      subject,
    })

    const { readStoredAttachmentImageDimensions } = await import('./io/attachmentImage') // prettier-ignore

    const imageDimensions = await readStoredAttachmentImageDimensions(
      ctx.storage,
      args.storageId,
    )
    const id = await ctx.runMutation(
      internal.attachments._confirmWithDimensions,
      {
        ...args,
        imageDimensions,
      },
    )
    return { id, imageDimensions }
  },
})

export const previewLink = action({
  args: { url: v.string() },
  handler: async (ctx, { url }) => {
    await getSubject(ctx)
    const { loadLinkPreview } = await import('../model/linkPreviews/preview')
    return loadLinkPreview(url)
  },
})
