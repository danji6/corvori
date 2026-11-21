import {
  attachmentNameSuffix,
  namelessAttachment,
  suffixFilename,
} from '@cv/core/utils/attachment-names'

import type { Id } from '../../_generated/dataModel'
import type { MutationCtx } from '../../_generated/server'

type AttachmentName = {
  sessionId: Id<'sessions'>
  filename: string
  mediaType: string
}

/** Allocates a filename in the same transaction that inserts the attachment. */
export async function allocateAttachmentName(
  ctx: MutationCtx,
  { sessionId, filename, mediaType }: AttachmentName,
) {
  const taken = (name: string) =>
    ctx.db
      .query('attachments')
      .withIndex('by_sessionId_filename', (q) =>
        q.eq('sessionId', sessionId).eq('filename', name),
      )
      .first()

  if (filename.trim() && !(await taken(filename))) return filename

  const base = filename.trim() ? filename : namelessAttachment(mediaType)
  let candidate = base
  for (let attempt = 0; attempt < 3; attempt++) {
    candidate = suffixFilename(base, attachmentNameSuffix())
    if (!(await taken(candidate))) return candidate
  }

  let number = 2
  while (await taken(suffixFilename(candidate, number))) number++
  return suffixFilename(candidate, number)
}
