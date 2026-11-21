import { assetFetcher } from '@/lib/fetcher'
import { toastError } from '@/lib/notifications'
import { download } from '@/lib/utils'

/** Saves the original attachment using the browser's download flow. */
export async function downloadAttachment(url: string, filename: string) {
  try {
    const blob = await assetFetcher<Blob>(url, 'blob')
    download(blob, filename)
  } catch (error) {
    toastError(error, 'Failed to download attachment')
  }
}
