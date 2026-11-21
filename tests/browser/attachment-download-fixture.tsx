import { ChatComposer } from '@/components/chat/composer/chat-composer'
import { FileBlock } from '@/components/chat/messages/file-block'
import { FileStrip } from '@/components/ui/file-strip'
import { LightboxProvider } from '@/components/ui/lightbox'
import { AttachmentUrlProvider } from '@/hooks/chat/attachment-urls'
import type { FileItem } from '@/hooks/file-previews'
import type { PendingMessage } from '@/lib/chat/types'
import { previewShares } from '@cv/convex/model/chat/sharedAttachments'
import { attachmentShareUrl } from '@cv/core/attachments'
import { ConvexQueryCacheProvider } from 'convex-helpers/react/cache'
import { ConvexProvider, type ConvexReactClient } from 'convex/react'
import { type FunctionReference, getFunctionName } from 'convex/server'
import { useState } from 'react'

const originalUrl = 'https://storage.example.test/api/storage/image'
const shareUrl = attachmentShareUrl(originalUrl, 'image')
const files: FileItem[] = [
  {
    id: 'image',
    file: new File([], 'image.png', { type: 'image/png' }),
    url: originalUrl,
    originalUrl,
    shareUrl,
  },
]

const publishedUrl = 'attachment:published'
const images = {
  first: { width: 320, height: 400 },
  second: { width: 1200, height: 1800 },
}
const attachmentUrls = {
  published: {
    url: 'https://storage.example.test/published-pdf',
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
  const ids = Object.keys(images)
  return (
    <LightboxProvider>
      <ConvexProvider client={attachmentClient}>
        <AttachmentUrlProvider />
        <div style={{ pointerEvents: 'none' }}>
          <FileBlock
            parts={ids.map((id) => ({
              type: 'file',
              url: `attachment:${id}`,
              mediaType: 'image/png',
              filename: `${id}.png`,
            }))}
            attachmentIds={Object.fromEntries(
              ids.map((id) => [`attachment:${id}`, id]),
            )}
          />
        </div>
      </ConvexProvider>
    </LightboxProvider>
  )
}

export function AttachmentDownloadFixture() {
  if (new URLSearchParams(location.search).has('gallery')) {
    return <AttachmentGalleryFixture />
  }

  return (
    <>
      <FileStrip files={files} noAnimation />
      <ConvexProvider client={attachmentClient}>
        <AttachmentUrlProvider />
        <FileBlock
          parts={[
            {
              type: 'file',
              url: publishedUrl,
              mediaType: 'application/pdf',
              filename: 'processed.pdf',
            },
          ]}
          attachmentIds={{ [publishedUrl]: 'published' }}
        />
      </ConvexProvider>
      <ConvexProvider client={attachmentClient}>
        <ConvexQueryCacheProvider>
          <AttachmentShareFixture />
        </ConvexQueryCacheProvider>
      </ConvexProvider>
    </>
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
          <FileStrip files={files} noAnimation />
        )}
      </div>
    </LightboxProvider>
  )
}
