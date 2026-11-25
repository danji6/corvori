import { ContextMenu } from '@/components/ui'
import { downloadAttachment } from '@/lib/chat/attachment-download'
import { writeClipboardText } from '@/lib/clipboard'
import { toast, toastError } from '@/lib/notifications'
import { DownloadIcon, LinkIcon } from 'lucide-react'

export type MessageTarget = {
  attachment?: HTMLElement
  link?: string
  download?: { url: string; filename: string }
}

export function resolveMessageTarget(
  target: Element | null,
): MessageTarget | null {
  const attachment = target?.closest<HTMLElement>('[data-attachment-name]')
  if (attachment) {
    const { attachmentName, attachmentUrl, attachmentShareUrl } =
      attachment.dataset
    const link =
      attachmentShareUrl ??
      (attachmentUrl && /^https?:\/\//i.test(attachmentUrl)
        ? attachmentUrl
        : undefined)
    const download =
      attachmentUrl && attachmentName
        ? { url: attachmentUrl, filename: attachmentName }
        : undefined
    return { attachment, link, download }
  }

  const anchor = target?.closest<HTMLAnchorElement>('a[href]:not([href=""])')
  return anchor?.href ? { link: anchor.href } : null
}

export function TargetActions({ target }: { target: MessageTarget }) {
  const { link, download } = target

  return (
    <>
      {download && (
        <ContextMenu.Item
          onSelect={() =>
            void downloadAttachment(download.url, download.filename)
          }
        >
          <DownloadIcon />
          Download
        </ContextMenu.Item>
      )}
      {link && (
        <ContextMenu.Item onSelect={() => void copyLink(link)}>
          <LinkIcon />
          Copy Link
        </ContextMenu.Item>
      )}
    </>
  )
}

async function copyLink(link: string) {
  try {
    await writeClipboardText(link)
    toast.success('Link copied')
  } catch (error) {
    toastError(error, 'Failed to copy link')
  }
}
