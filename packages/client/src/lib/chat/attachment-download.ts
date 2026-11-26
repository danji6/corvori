import { getConvexClientUrl } from '@/lib/auth/site-url'
import { assetFetcher } from '@/lib/fetcher'
import { toastError } from '@/lib/notifications'
import { download, downloadFromUrl } from '@/lib/utils'
import {
  ATTACHMENT_DOWNLOAD_PATH,
  CONVEX_STORAGE_PATH,
  storageIdFromPath,
} from '@cv/core/attachment-download'

/** Saves the original attachment using the browser's download flow. */
export async function downloadAttachment(url: string, filename: string) {
  try {
    const source = new URL(url, window.location.href)
    const nativeUrl = nativeDownloadUrl(source, filename)
    if (nativeUrl) {
      downloadFromUrl(nativeUrl, filename)
      return
    }
    const blob = await assetFetcher<Blob>(url, 'blob')
    download(blob, filename)
  } catch (error) {
    toastError(error, 'Failed to download attachment')
  }
}

function nativeDownloadUrl(source: URL, filename: string) {
  if (source.protocol === 'blob:' || source.protocol === 'data:')
    return source.href

  const convexUrl = getConvexClientUrl({
    CURRENT_ORIGIN: window.location.origin,
    VITE_CONVEX_URL: import.meta.env.VITE_CONVEX_URL,
  })
  if (source.origin !== new URL(convexUrl).origin) return

  const id = storageIdFromPath(source.pathname, CONVEX_STORAGE_PATH)
  if (!id) return

  const params = new URLSearchParams({ filename })
  const component = source.searchParams.get('component')
  if (component) params.set('component', component)

  return `${ATTACHMENT_DOWNLOAD_PATH}${id}?${params}`
}
