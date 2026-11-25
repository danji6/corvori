import { T } from '@/components/ui/typography'
import { useAttachmentUrls } from '@/hooks/chat/attachment-urls'
import { attachmentReference } from '@cv/core/attachments'
import { useMemo } from 'react'

/** Resolves a session attachment to its current browser URL. */
export function AttachmentAnchor({
  href,
  ...props
}: { href: string } & React.ComponentProps<'a'>) {
  const reference = attachmentReference(href)
  const id = reference?.attachmentId
  const ids = useMemo(() => (id ? [id] : []), [id])
  const resolved = useAttachmentUrls(ids)
  const attachment = id ? resolved[id] : undefined

  return (
    <T.a
      {...props}
      href={attachment?.url ?? undefined}
      data-attachment-name={reference?.filename}
      data-attachment-url={attachment?.url ?? undefined}
      data-attachment-share-url={attachment?.shareUrl ?? undefined}
      target="_blank"
      rel="noopener noreferrer"
    />
  )
}
