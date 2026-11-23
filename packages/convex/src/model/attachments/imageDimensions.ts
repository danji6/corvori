'use node'

import type { Id } from '../../_generated/dataModel'
import type { ActionCtx } from '../../_generated/server'
import type { AttachmentImageDimensions } from '../../validators/attachments'

export async function readStoredAttachmentImageDimensions(
  storage: ActionCtx['storage'],
  storageId: Id<'_storage'>,
) {
  const blob = await storage.get(storageId)
  if (!blob) return
  return readAttachmentImageDimensions(new Uint8Array(await blob.arrayBuffer()))
}

/** Reads display-oriented dimensions from the original image header. */
export async function readAttachmentImageDimensions(
  bytes: Uint8Array,
): Promise<AttachmentImageDimensions | undefined> {
  const { imageSize } = await import('image-size-next')
  try {
    const { width, height, orientation } = imageSize(bytes)
    if (!Number.isSafeInteger(width) || width <= 0) return
    if (!Number.isSafeInteger(height) || height <= 0) return

    const swapsAxes =
      orientation !== undefined && orientation >= 5 && orientation <= 8
    return swapsAxes ? { width: height, height: width } : { width, height }
  } catch {
    // Unrecognized images can still be rendered by the browser.
    return undefined
  }
}
