import { useAttachmentUrls } from '@/hooks/chat'
import { buildFileItemFromPart } from '@/lib/chat'
import { getAttachmentSendPreview } from '@/lib/chat/attachment-send-previews'
import { useMessageUploadState } from '@/lib/chat/message-uploads'
import { isDisplayableUrl } from '@/lib/io'
import type { Id } from '@cv/convex/_generated/dataModel'
import type { FileUIPart } from 'ai'
import { useMemo } from 'react'

import { FileStrip } from '../../ui'
import { useMessage } from './message-context'

export type FileBlockProps = {
  parts: FileUIPart[]
  attachmentIds?: Record<string, string>
}

export function FileBlock({ parts, attachmentIds }: FileBlockProps) {
  const upload = useMessageUploadState(useMessage()?.id)
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
          resolved?.previewUrl ?? local?.preview?.url ?? local?.fallbackUrl,
          resolved?.shareUrl ?? undefined,
          resolved?.byteLength ?? local?.byteLength,
        )
        const hasDirectSource =
          !part.url.startsWith('attachment:') && isDisplayableUrl(file.url)

        return {
          ...file,
          originalUrl:
            file.originalUrl ?? (hasDirectSource ? file.url : undefined),
          originalFile: local?.file,
          localPreview: local?.preview,
          imageDimensions: resolved?.imageDimensions ?? local?.imageDimensions,
          upload: upload?.files[local?.key ?? part.url],
        }
      }),
    [parts, attachmentIds, urls, upload],
  )
  const discard = upload?.discard
  const discardTarget =
    discard &&
    (files.find((file) => file.upload?.phase === 'failed') ??
      files.find((file) => file.originalFile) ??
      files[0])

  return (
    <div className="min-w-0">
      <FileStrip
        data-slot="file-block"
        files={files}
        size={128}
        actionsInContextMenu
        discardMessage={
          discard && discardTarget
            ? { fileId: discardTarget.id, onClick: discard }
            : undefined
        }
        // Virtua disables pointer events on the list while scrolling.
        className="pointer-events-auto gap-(--message-block-gap) p-0"
        noAnimation
      />
      {upload?.error && (
        <div className="pointer-events-auto mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <span role="status" className="text-destructive">
            {upload.error}
          </span>
          {upload.retry && (
            <button type="button" onClick={upload.retry}>
              Retry message
            </button>
          )}
        </div>
      )}
    </div>
  )
}
