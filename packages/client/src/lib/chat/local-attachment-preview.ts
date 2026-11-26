import type { LocalFilePreview } from '@/hooks/file-previews'
import { ACCEPTED_IMAGE_TYPES, ACCEPTED_VIDEO_TYPES } from '@/lib/io'

const MAX_IMAGE_DIMENSION = 640
const thumbnails = new WeakMap<Blob, Promise<Blob | null>>()

function localAttachmentKind(type: string, filename: string) {
  if (type.startsWith('image/')) return 'image'
  if (type.startsWith('video/')) return 'video'
  if (type && type !== 'application/octet-stream') return
  const name = filename.toLowerCase()
  if (
    ACCEPTED_IMAGE_TYPES.some(({ extensions }) =>
      extensions.some((ext) => name.endsWith(`.${ext}`)),
    )
  )
    return 'image'
  if (
    ACCEPTED_VIDEO_TYPES.some(({ extensions }) =>
      extensions.some((ext) => name.endsWith(`.${ext}`)),
    )
  )
    return 'video'
}

export function getAttachmentThumbnail(file: Blob) {
  let thumbnail = thumbnails.get(file)
  if (!thumbnail) {
    thumbnail = resizeImage(file).catch(() => null)
    thumbnails.set(file, thumbnail)
  }
  return thumbnail
}

async function resizeImage(file: Blob) {
  const bitmap = await createImageBitmap(file)
  try {
    return await drawThumbnail(bitmap, bitmap.width, bitmap.height)
  } finally {
    bitmap.close()
  }
}

async function drawThumbnail(
  source: CanvasImageSource,
  width: number,
  height: number,
) {
  const scale = Math.min(MAX_IMAGE_DIMENSION / Math.max(width, height), 1)
  const canvas = new OffscreenCanvas(
    Math.max(1, Math.round(width * scale)),
    Math.max(1, Math.round(height * scale)),
  )
  const context = canvas.getContext('2d')
  if (!context) return null
  context.drawImage(source, 0, 0, canvas.width, canvas.height)
  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 })
}

async function readVideoPoster(url: string, signal: AbortSignal) {
  const video = document.createElement('video')
  video.muted = true
  video.preload = 'auto'
  try {
    await new Promise<void>((resolve, reject) => {
      signal.throwIfAborted()
      signal.addEventListener('abort', () => reject(signal.reason), {
        once: true,
        signal,
      })
      video.addEventListener('loadeddata', () => resolve(), {
        once: true,
        signal,
      })
      video.addEventListener(
        'error',
        () => reject(new Error('Video preview unavailable')),
        { once: true, signal },
      )
      video.src = url
    })
    signal.throwIfAborted()
    return await drawThumbnail(video, video.videoWidth, video.videoHeight)
  } finally {
    video.removeAttribute('src')
    video.load()
  }
}

/** Owns the object URLs for a local, lazily rendered media tile. */
export function createLocalAttachmentPreview(file: File) {
  const kind = localAttachmentKind(file.type, file.name)
  if (!kind) return
  const url = URL.createObjectURL(file)
  let thumbnailUrl: string | undefined
  const controller = new AbortController()
  const { signal } = controller
  const preview: LocalFilePreview = {
    url,
    kind,
    async loadThumbnail() {
      const thumbnail =
        kind === 'image'
          ? await getAttachmentThumbnail(file)
          : await readVideoPoster(url, signal).catch(() => null)
      if (signal.aborted) return null
      if (!thumbnail) return kind === 'image' ? url : null
      thumbnailUrl ??= URL.createObjectURL(thumbnail)
      return thumbnailUrl
    },
  }
  return {
    preview,
    release() {
      controller.abort()
      URL.revokeObjectURL(url)
      if (thumbnailUrl) URL.revokeObjectURL(thumbnailUrl)
    },
  }
}
