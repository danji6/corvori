import type { LocalFilePreview } from '@/hooks/file-previews'
import type { Id } from '@cv/convex/_generated/dataModel'
import type { AttachmentImageDimensions } from '@cv/convex/validators/attachments'

export type StagedAttachment = {
  id: Id<'attachments'>
  filename: string
  mediaType: string
  byteLength: number
  imageDimensions?: AttachmentImageDimensions
}

type LocalAttachment = {
  url: string
  source: string | Blob
  byteLength?: number
}

type SendPreview = Partial<
  Pick<StagedAttachment, 'byteLength' | 'imageDimensions'>
> & {
  key: string
  preview: LocalFilePreview
}

const HANDOFF_MS = 60_000
const staged = new Map<string, SendPreview>()

export function getAttachmentSendPreview(id: string) {
  return staged.get(id)
}

/** Keeps each preview available before and after its attachment ID is assigned. */
export function keepAttachmentSendPreviews(files: LocalAttachment[]) {
  const objectUrls: string[] = []
  const previews = files.map(({ url, source, byteLength }) => {
    const src = typeof source === 'string' ? source : URL.createObjectURL(source) // prettier-ignore
    if (typeof source !== 'string') objectUrls.push(src)
    const local = { key: url, byteLength, preview: { url: src } }
    staged.set(url, local)
    return local
  })

  let confirmed: StagedAttachment[] = []
  return {
    confirm(attachments: StagedAttachment[]) {
      confirmed = attachments
      // Upload results preserve the composer order.
      attachments.forEach(({ id, byteLength, imageDimensions }, index) => {
        staged.set(id, {
          ...previews[index],
          byteLength,
          imageDimensions,
        })
      })
    },
    releaseWhenFinished(sent: boolean) {
      for (const { url } of files) staged.delete(url)
      const release = () => {
        for (const { id } of confirmed) staged.delete(id)
        for (const url of objectUrls) URL.revokeObjectURL(url)
      }
      if (sent) setTimeout(release, HANDOFF_MS)
      else release()
    },
  }
}
