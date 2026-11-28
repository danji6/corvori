import {
  FILE_IMAGE_MAX_BYTES,
  type FileImageOutput,
} from '@cv/core/workspace/read-image'
import sharp, { type Sharp } from 'sharp'

import { type TextReadOptions, readFilePrefix } from './read-text'

const MAX_INPUT_BYTES = 20 * 1024 * 1024
const MAX_INPUT_PIXELS = 40_000_000
const PREVIEW_SIZES = [1536, 1280, 1000, 768, 512, 256]
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

function imageFormat(bytes: Buffer) {
  if (bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return 'png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg'
  const header = bytes.toString('latin1', 0, 12)
  if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) return 'gif'
  if (header.startsWith('RIFF') && header.slice(8) === 'WEBP') return 'webp'
}

/** Detects supported raster types before the UTF-8 reader opens the file. */
export async function readImagePreview(
  filename: string,
  options: TextReadOptions,
) {
  const sample = await readFilePrefix(filename, 12)
  const format = imageFormat(sample.buffer)
  if (!format) return undefined

  const hasPaging = [options.offset, options.limit, options.byteOffset].some(
    (value) => value !== undefined,
  )
  if (hasPaging)
    throw new Error('Image reads do not accept text paging options')

  const source = await readFilePrefix(filename, MAX_INPUT_BYTES)
  if (source.truncated) throw new Error('Image exceeds the 20 MiB read limit')
  if (format !== imageFormat(source.buffer))
    throw new Error('Image changed during read')
  return renderPreview(source.buffer, format)
}

async function renderPreview(
  source: Buffer,
  format: string,
): Promise<Omit<FileImageOutput, 'path'>> {
  try {
    const image = sharp(source, {
      limitInputPixels: MAX_INPUT_PIXELS,
      pages: 1,
    })
    const metadata = await image.metadata()
    if (metadata.format !== format) throw new Error('Unexpected image format')
    const { width: originalWidth, height: originalHeight } = metadata.autoOrient
    if (originalWidth * originalHeight > MAX_INPUT_PIXELS)
      throw new Error('Image exceeds the 40 megapixel limit')

    const longestEdge = Math.max(originalWidth, originalHeight)
    const { data, info } = await encodePreview(
      image,
      longestEdge,
      metadata.hasAlpha,
    )

    return {
      kind: 'image',
      mediaType: info.format === 'jpeg' ? 'image/jpeg' : 'image/png',
      originalWidth,
      originalHeight,
      width: info.width,
      height: info.height,
      base64: data.toString('base64'),
    }
  } catch (error) {
    const detail =
      error instanceof Error ? error.message : 'Unknown decoder error'
    throw new Error(`Could not read image: ${detail}`, { cause: error })
  }
}

async function encodePreview(
  image: Sharp,
  longestEdge: number,
  hasAlpha: boolean,
) {
  const sizes = new Set(
    PREVIEW_SIZES.map((size) => Math.min(size, longestEdge)),
  )
  let isOpaque = hasAlpha ? undefined : true

  for (const size of sizes) {
    const preview = image
      .clone()
      .autoOrient()
      .resize(size, size, { fit: 'inside', withoutEnlargement: true })
    const lossless = await preview
      .clone()
      .png()
      .toBuffer({ resolveWithObject: true })
    if (lossless.data.length <= FILE_IMAGE_MAX_BYTES) return lossless

    isOpaque ??= (await image.stats()).isOpaque
    const encoder = isOpaque
      ? preview.jpeg({ quality: 75 })
      : preview.png({ palette: true, dither: 0, effort: 1 })
    const compressed = await encoder.toBuffer({ resolveWithObject: true })
    if (compressed.data.length <= FILE_IMAGE_MAX_BYTES) return compressed
  }

  throw new Error('Image preview exceeds the 512 KiB output limit')
}
