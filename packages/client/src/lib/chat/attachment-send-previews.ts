import type { LocalFilePreview } from '@/hooks/file-previews'
import type { Id } from '@cv/convex/_generated/dataModel'
import type { AttachmentImageDimensions } from '@cv/convex/validators/attachments'
import { isKnownTextFile } from '@cv/core/workspace/files'

import { createLocalAttachmentPreview } from './local-attachment-preview'

export type StagedAttachment = {
  id: Id<'attachments'>
  imageDimensions?: AttachmentImageDimensions
}

type LocalAttachment = {
  url: string
  file: File
}

type SendPreview = {
  key: string
  byteLength: number
  imageDimensions?: AttachmentImageDimensions
  preview?: LocalFilePreview
  fallbackUrl?: string
  file?: File
}

const HANDOFF_MS = 60_000
const staged = new Map<string, SendPreview>()

export function getAttachmentSendPreview(id: string) {
  return staged.get(id)
}

/** Keeps each preview available before and after its attachment ID is assigned. */
export function keepAttachmentSendPreviews(files: LocalAttachment[]) {
  const owned = files.map(({ url, file }) => {
    const local = createLocalAttachmentPreview(file)
    const textUrl =
      !local && isKnownTextFile(file.type, file.name)
        ? URL.createObjectURL(file)
        : undefined
    const entry: SendPreview = {
      key: url,
      byteLength: file.size,
      file,
      preview: local?.preview,
      fallbackUrl: textUrl,
    }
    staged.set(url, entry)
    return { url, entry, local, textUrl }
  })
  const confirmed = new Set<Id<'attachments'>>()

  return {
    confirm(attachments: StagedAttachment[]) {
      attachments.forEach(({ id, imageDimensions }, index) => {
        confirmed.add(id)
        const { entry } = owned[index]
        staged.set(id, {
          ...entry,
          imageDimensions,
        })
      })
    },
    releaseWhenFinished(sent: boolean) {
      for (const { url, entry } of owned) {
        staged.delete(url)
        delete entry.file
      }
      const release = () => {
        for (const id of confirmed) staged.delete(id)
        for (const { local, textUrl } of owned) {
          local?.release()
          if (textUrl) URL.revokeObjectURL(textUrl)
        }
      }
      if (!sent) {
        release()
        return
      }
      for (const id of confirmed) {
        const entry = staged.get(id)
        if (entry) delete entry.file
      }
      setTimeout(release, HANDOFF_MS)
    },
  }
}
