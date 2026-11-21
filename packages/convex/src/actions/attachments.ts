'use node'

import { v } from 'convex/values'

import { action } from '../_generated/server'
import { getSubject } from '../functions'
import type { ConfirmedImage } from '../model/attachments/actions'
import { confirmAttachmentArgsValidator } from '../validators/attachments'

export const confirmImage = action({
  args: confirmAttachmentArgsValidator.fields,
  handler: async (ctx, args): Promise<ConfirmedImage> => {
    const { confirmImage } = await import('../model/attachments/actions')
    return confirmImage(ctx, args)
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
