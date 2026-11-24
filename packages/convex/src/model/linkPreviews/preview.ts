'use node'

import type { IncomingMessage } from 'node:http'

import type { LinkPreviewMetadata } from '../../validators/linkPreviews'
import { openPublicHttp, publicHttpUrl, readLimited } from './publicHttp'

type FetchedLinkPreview = LinkPreviewMetadata & { image?: Blob }

const IMAGE_LIMIT = 384 * 1024
const HTML_LIMIT = 512 * 1024
const IMAGE_TYPE = /^image\/(?:apng|avif|gif|jpeg|png|webp)$/

export async function loadLinkPreview(
  value: string,
): Promise<FetchedLinkPreview | null> {
  if (value.length > 2_048) return null
  const signal = AbortSignal.timeout(5_000)
  try {
    const url = publicHttpUrl(value)
    const youtubeId = youtubeVideoId(url)
    if (youtubeId) return youtubePreview(youtubeId, signal)

    const source = await openPublicHttp(url.href, signal)
    try {
      return await responsePreview(source.url, source.response, signal)
    } finally {
      source.response.destroy()
    }
  } catch {
    return null
  }
}

async function responsePreview(
  url: URL,
  response: IncomingMessage,
  signal: AbortSignal,
): Promise<FetchedLinkPreview | null> {
  const mediaType = contentType(response)
  const title = (url.pathname.split('/').pop() || url.hostname).slice(0, 200)

  if (IMAGE_TYPE.test(mediaType)) {
    const image = await readImage(response)
    return { kind: 'image', title, image }
  }
  if (mediaType.startsWith('video/')) return { kind: 'video', title }
  if (mediaType.startsWith('audio/')) return { kind: 'audio', title }
  if (mediaType !== 'text/html') return null

  return openGraphPreview(
    url,
    await readLimited(response, HTML_LIMIT, 'prefix'),
    signal,
  )
}

async function openGraphPreview(url: URL, html: Buffer, signal: AbortSignal) {
  const { parseHTML } = await import('linkedom')
  const { document } = parseHTML(html.toString('utf8'))
  const fields = new Map<string, string>()

  for (const meta of document.querySelectorAll('meta[property]')) {
    const key = meta.getAttribute('property')?.toLowerCase()
    const value = meta.getAttribute('content')?.trim()
    if (key && value && !fields.has(key)) fields.set(key, value)
  }

  const title = fields.get('og:title')
  if (!title) return null

  const preview: FetchedLinkPreview = {
    kind: 'website',
    title: title.slice(0, 200),
  }
  const description = fields.get('og:description')
  if (description) preview.description = description.slice(0, 400)
  const image = fields.get('og:image:secure_url') ?? fields.get('og:image')
  if (image) preview.image = await loadImage(image, url, signal)
  if (!preview.image) delete preview.image

  return preview
}

async function loadImage(
  value: string,
  base: URL | undefined,
  signal: AbortSignal,
) {
  try {
    const url = publicHttpUrl(value, base)
    const { response } = await openPublicHttp(url.href, signal)
    try {
      if (IMAGE_TYPE.test(contentType(response)))
        return await readImage(response)
    } finally {
      response.destroy()
    }
  } catch {
    // An unavailable image can leave the text preview intact.
  }
}

async function readImage(response: IncomingMessage) {
  const image = await readLimited(response, IMAGE_LIMIT)
  return new Blob([new Uint8Array(image)], { type: contentType(response) })
}

function contentType(response: IncomingMessage) {
  return (
    response.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() ??
    ''
  )
}

function youtubeVideoId(url: URL) {
  let id
  if (url.hostname === 'youtu.be') {
    id = url.pathname.slice(1)
  } else if (
    ['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname)
  ) {
    id =
      url.pathname === '/watch'
        ? url.searchParams.get('v')
        : /^\/(?:shorts|live|embed)\/([^/]+)$/.exec(url.pathname)?.[1]
  }
  return id && /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null
}

async function youtubePreview(
  id: string,
  signal: AbortSignal,
): Promise<FetchedLinkPreview> {
  const image = await loadImage(
    `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    undefined,
    signal,
  )
  return { kind: 'video', title: 'YouTube video', ...(image && { image }) }
}
