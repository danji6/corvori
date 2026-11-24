'use node'

import { action } from '../_generated/server'
import type { ConfirmedImage } from '../model/attachments/actions'
import { confirmAttachmentArgsValidator } from '../validators/attachments'

export const confirmImage = action({
  args: confirmAttachmentArgsValidator.fields,
  handler: async (ctx, args): Promise<ConfirmedImage> => {
    const { confirmImage } = await import('../model/attachments/actions')
    return confirmImage(ctx, args)
  },
})
