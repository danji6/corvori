import { useAttachmentUrls } from '@/hooks/chat'
import { buildFileItemFromPart } from '@/lib/chat'
import { getAttachmentSendPreview } from '@/lib/chat/attachment-send-previews'
import type { Id } from '@cv/convex/_generated/dataModel'
import type { FileUIPart } from 'ai'
import { useMemo } from 'react'

import { FileStrip } from '../../ui'

export type FileBlockProps = {
  parts: FileUIPart[]
  attachmentIds?: Record<string, string>
}

export function FileBlock({ parts, attachmentIds }: FileBlockProps) {
  const ids = useMemo(
    () =>
      attachmentIds
        ? (Object.values(attachmentIds) as Id<'attachments'>[])
        : [],
    [attachmentIds],
  )
  const urls = useAttachmentUrls(ids)

  const files = useMemo(
    () =>
      parts.map((part, index) => {
        const attachmentId = attachmentIds?.[part.url]
        const resolved = attachmentId ? urls[attachmentId] : undefined
        const local = getAttachmentSendPreview(attachmentId ?? part.url)
        const file = buildFileItemFromPart(
          part,
          local?.key ?? `${index}:${attachmentId ?? part.url}`,
          resolved?.url ?? undefined,
          resolved?.previewUrl ?? local?.preview.url,
          resolved?.shareUrl ?? undefined,
          resolved?.byteLength ?? local?.byteLength,
        )
        return {
          ...file,
          localPreview: local?.preview,
          imageDimensions: resolved?.imageDimensions ?? local?.imageDimensions,
        }
      }),
    [parts, attachmentIds, urls],
  )

  return (
    <FileStrip
      data-slot="file-block"
      files={files}
      size={128}
      // Virtua disables pointer events on the list while scrolling.
      className="pointer-events-auto gap-(--message-block-gap) p-0"
      noAnimation
    />
  )
}
