import type { Id } from '@cv/convex/_generated/dataModel'

/** Sends raw file bytes and reports the browser's upload progress. */
export function uploadAttachmentBlob(
  url: string,
  blob: Blob,
  mediaType: string,
  signal: AbortSignal,
  onProgress?: (fraction?: number) => void,
): Promise<Id<'_storage'>> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const xhr = new XMLHttpRequest()
    const abort = () => xhr.abort()
    signal.addEventListener('abort', abort, { once: true })
    xhr.addEventListener('loadend', () =>
      signal.removeEventListener('abort', abort),
    )
    if (onProgress) {
      xhr.upload.addEventListener('progress', (event) => {
        onProgress(
          event.lengthComputable && event.total > 0
            ? Math.min(1, event.loaded / event.total)
            : undefined,
        )
      })
    }

    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(`Upload failed (HTTP ${xhr.status})`))
        return
      }
      const id: unknown = xhr.response?.storageId
      if (typeof id === 'string' && id) resolve(id as Id<'_storage'>)
      else reject(new Error('Storage did not acknowledge the upload'))
    }
    xhr.onerror = () => reject(new Error('Network error while uploading'))
    xhr.onabort = () => reject(signal.reason ?? new Error('Upload canceled'))
    xhr.ontimeout = () => reject(new Error('Upload timed out'))
    try {
      xhr.open('POST', url)
      xhr.responseType = 'json'
      xhr.setRequestHeader('Content-Type', mediaType)
      xhr.send(blob)
    } catch (error) {
      signal.removeEventListener('abort', abort)
      reject(error)
    }
  })
}
