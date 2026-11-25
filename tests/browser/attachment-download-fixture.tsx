import { ChatComposer } from '@/components/chat/composer/chat-composer'
import { MessageContextMenu } from '@/components/chat/messages/context-menu/message-context-menu'
import { FileBlock } from '@/components/chat/messages/file-block'
import {
  MessageHighlightLayer,
  MessageHighlightProvider,
  useMessageHighlightRef,
} from '@/components/chat/messages/message-highlight-context'
import { AttachmentAnchor } from '@/components/markdown/attachment-anchor'
import { LightboxProvider } from '@/components/ui/lightbox'
import { AttachmentUrlProvider } from '@/hooks/chat/attachment-urls'
import { ChatMessagesProvider } from '@/hooks/chat/messages'
import type { PendingMessage } from '@/lib/chat/types'
import { previewShares } from '@cv/convex/model/chat/sharedAttachments'
import { attachmentShareUrl } from '@cv/core/attachments'
import type { FileUIPart, UIMessage } from 'ai'
import { ConvexQueryCacheProvider } from 'convex-helpers/react/cache'
import { ConvexProvider, type ConvexReactClient } from 'convex/react'
import { type FunctionReference, getFunctionName } from 'convex/server'
import { useRef, useState } from 'react'

const originalUrl = 'https://storage.example.test/api/storage/image'
const shareUrl = attachmentShareUrl(originalUrl, 'image')
const imagePart: FileUIPart = {
  type: 'file',
  url: 'attachment:image',
  mediaType: 'image/png',
  filename: 'image.png',
}

const publishedUrl = 'attachment:published'
const publishedStorageUrl = 'https://storage.example.test/published-pdf'
const publishedPart: FileUIPart = {
  type: 'file',
  url: publishedUrl,
  mediaType: 'application/pdf',
  filename: 'processed.pdf',
}
const images = {
  first: { width: 320, height: 400 },
  second: { width: 1200, height: 1800 },
}
const attachmentUrls = {
  image: { url: originalUrl, shareUrl },
  published: {
    url: publishedStorageUrl,
    shareUrl: attachmentShareUrl(publishedStorageUrl, 'published'),
    byteLength: 13,
    mediaType: 'application/pdf',
    filename: 'processed.pdf',
  },
  ...Object.fromEntries(
    Object.entries(images).map(([id, imageDimensions]) => [
      id,
      {
        url: `https://storage.example.test/${id}-original.png`,
        previewUrl: `https://storage.example.test/${id}-preview.png`,
        imageDimensions,
      },
    ]),
  ),
}
const shareResults = new Map<
  string,
  Awaited<ReturnType<typeof previewShares>>
>()

const attachmentClient = {
  watchQuery(query: FunctionReference<'query'>, args: { urls: string[] }) {
    if (getFunctionName(query) === 'attachments:previewShares') {
      const key = JSON.stringify(args.urls)
      return {
        onUpdate: (update: () => void) => {
          let subscribed = true
          void previewShares(
            {
              db: {
                normalizeId: (_table: string, id: string) => id,
                get: (id: string) =>
                  id === 'image'
                    ? {
                        _id: id,
                        storageId: 'image',
                        filename: 'image.png',
                        mediaType: 'image/png',
                      }
                    : null,
              },
              storage: { getUrl: () => originalUrl },
            } as never,
            args,
          ).then((shares) => {
            shareResults.set(key, shares)
            if (subscribed) update()
          })
          return () => {
            subscribed = false
          }
        },
        localQueryResult: () => shareResults.get(key),
        journal: () => undefined,
      }
    }
    return {
      onUpdate: () => () => {},
      localQueryResult: () => attachmentUrls,
      localQueryLogs: () => [],
      journal: () => undefined,
    }
  },
} as unknown as ConvexReactClient

/** Mirrors the pointer-event guard on the virtualized chat list. */
function AttachmentGalleryFixture() {
  return (
    <LightboxProvider>
      <ConvexProvider client={attachmentClient}>
        <ConvexQueryCacheProvider>
          <ChatMessagesProvider>
            <AttachmentUrlProvider />
            <MessageHighlightProvider>
              <AttachmentGalleryMessage />
            </MessageHighlightProvider>
          </ChatMessagesProvider>
        </ConvexQueryCacheProvider>
      </ConvexProvider>
    </LightboxProvider>
  )
}

const galleryIds = Object.keys(images)
const galleryFiles = galleryIds.map<FileUIPart>((id) => ({
  type: 'file',
  url: `attachment:${id}`,
  mediaType: 'image/png',
  filename: `${id}.png`,
}))
const galleryAttachmentIds = Object.fromEntries(
  galleryIds.map((id) => [`attachment:${id}`, id]),
)
const galleryMessage: UIMessage = {
  id: 'gallery',
  role: 'user',
  parts: [{ type: 'text', text: 'Gallery message' }, ...galleryFiles],
}
const galleryRow = {
  kind: 'header',
  key: 'gallery',
  messageId: 'gallery',
} as const
const galleryRows = [galleryRow]

function AttachmentGalleryMessage() {
  const root = useRef<HTMLDivElement>(null)
  const messageRef = useMessageHighlightRef(galleryMessage.id)
  return (
    <div ref={root} className="relative p-8">
      <MessageHighlightLayer root={root} rows={galleryRows} layoutVersion={0} />
      <MessageContextMenu
        message={galleryMessage}
        row={galleryRow}
        canMutate={false}
      >
        <div
          ref={messageRef}
          data-sender-group-id={galleryMessage.id}
          className="relative"
        >
          <p>Gallery message</p>
          <AttachmentAnchor href="attachment:published/processed.pdf">
            Inline attachment
          </AttachmentAnchor>
          <div style={{ pointerEvents: 'none' }}>
            <FileBlock
              parts={galleryFiles}
              attachmentIds={galleryAttachmentIds}
            />
          </div>
        </div>
      </MessageContextMenu>
    </div>
  )
}

export function AttachmentDownloadFixture() {
  if (new URLSearchParams(location.search).has('gallery')) {
    return <AttachmentGalleryFixture />
  }

  return (
    <ConvexProvider client={attachmentClient}>
      <ConvexQueryCacheProvider>
        <ChatMessagesProvider>
          <AttachmentUrlProvider />
          <AttachmentMessage
            id="source-image"
            part={imagePart}
            attachmentId="image"
          />
          <AttachmentMessage
            id="published"
            part={publishedPart}
            attachmentId="published"
          />
          <AttachmentShareFixture />
        </ChatMessagesProvider>
      </ConvexQueryCacheProvider>
    </ConvexProvider>
  )
}

type AttachmentMessageProps = {
  id: string
  part: FileUIPart
  attachmentId: string
}

function AttachmentMessage({ id, part, attachmentId }: AttachmentMessageProps) {
  const message: UIMessage = { id, role: 'user', parts: [part] }

  return (
    <MessageContextMenu
      message={message}
      row={{ kind: 'header', key: id, messageId: id }}
      canMutate={false}
    >
      <div data-message-id={id}>
        <FileBlock
          parts={[part]}
          attachmentIds={{ [part.url]: attachmentId }}
        />
      </div>
    </MessageContextMenu>
  )
}

function AttachmentShareFixture() {
  const [sent, setSent] = useState<PendingMessage>()

  return (
    <LightboxProvider>
      <section aria-label="Receiving session">
        <ChatComposer hideTokenWidget onSubmit={setSent} />
      </section>
      <div data-testid="sent-message">
        {sent?.content}
        {sent?.files.some((part) => part.share?.shareUrl === shareUrl) && (
          <AttachmentMessage
            id="sent-image"
            part={imagePart}
            attachmentId="image"
          />
        )}
      </div>
    </LightboxProvider>
  )
}
