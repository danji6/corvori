import { useAttachmentUrls } from '@/hooks/chat/attachment-urls'
import { useFilePreviews } from '@/hooks/file-previews'
import { buildFileItemFromPart } from '@/lib/chat/parts'
import { api } from '@cv/convex/_generated/api'
import type { ReplyQuote } from '@cv/convex/validators/messages'
import { useQuery } from 'convex/react'
import type { FunctionReturnType } from 'convex/server'
import { FileIcon } from 'lucide-react'
import { useMemo, useState } from 'react'

type ReplyFile = NonNullable<
  FunctionReturnType<typeof api.chat.replyAttachment>
>

/** Shows a compact preview of the first file in the quoted message. */
export function ReplyAttachmentThumbnail({ quote }: { quote: ReplyQuote }) {
  const file = useQuery(
    api.chat.replyAttachment,
    quote.target ? { messageId: quote.target.id } : 'skip',
  )
  if (!file) return null

  return <AttachmentThumbnail file={file} />
}

function AttachmentThumbnail({ file }: { file: ReplyFile }) {
  const { attachmentId } = file
  const ids = useMemo(
    () => (attachmentId ? [attachmentId] : []),
    [attachmentId],
  )
  const urls = useAttachmentUrls(ids)
  const resolved = attachmentId ? urls[attachmentId] : undefined
  const items = useMemo(
    () => [
      buildFileItemFromPart(
        file,
        attachmentId ?? file.url,
        resolved?.url ?? undefined,
        resolved?.previewUrl ?? undefined,
      ),
    ],
    [file, attachmentId, resolved?.url, resolved?.previewUrl],
  )
  const [preview] = useFilePreviews(items)
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const src = preview.thumbnailUrl
  const name = items[0].file.name

  return (
    <div
      data-slot="reply-attachment-thumbnail"
      className="bg-m3-surface-container-high text-m3-on-surface-variant ml-2 flex size-9 shrink-0 items-center justify-center self-center overflow-hidden rounded-md"
    >
      {src && src !== failedSrc ? (
        <img
          src={src}
          alt={name}
          className="size-full object-cover"
          onError={() => setFailedSrc(src)}
        />
      ) : (
        <span role="img" aria-label={name}>
          <FileIcon className="size-4" />
        </span>
      )}
    </div>
  )
}
