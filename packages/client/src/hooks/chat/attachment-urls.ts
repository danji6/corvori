import { normalizeBrowserUrl } from '@/lib/auth/site-url'
import { api } from '@cv/convex/_generated/api'
import type { AttachmentImageDimensions } from '@cv/convex/types'
import { useEffect, useMemo } from 'react'

import { createMediaUrlStore } from './media-urls'

const store = createMediaUrlStore(api.attachments.getUrlMap)

/** Resolves every requested attachment in one query. */
export const AttachmentUrlProvider = store.Provider

export type AttachmentUrls = {
  url: string | null
  previewUrl: string | null
  shareUrl: string | null
  byteLength: number | null
  imageDimensions?: AttachmentImageDimensions
}

/** Resolves many attachments to their normalized URLs from the shared cache. */
export function useAttachmentUrls(
  ids: string[],
): Record<string, AttachmentUrls> {
  useEffect(() => store.register(ids), [ids])

  const map = store.useMediaUrls()

  return useMemo(() => {
    const out: Record<string, AttachmentUrls> = {}

    for (const id of ids) {
      const entry = map[id]
      out[id] = {
        url: entry ? normalizeBrowserUrl(entry.url) : null,
        previewUrl: entry
          ? normalizeBrowserUrl(entry.previewUrl ?? entry.url)
          : null,
        shareUrl: entry?.shareUrl ?? null,
        byteLength: entry?.byteLength ?? null,
        imageDimensions: entry?.imageDimensions,
      }
    }

    return out
  }, [ids, map])
}
