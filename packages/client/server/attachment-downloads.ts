import { createHash } from 'node:crypto'
import { type IncomingMessage, type ServerResponse, request } from 'node:http'
import { pipeline } from 'node:stream'
import type { Connect, Plugin } from 'vite'

import {
  ATTACHMENT_DOWNLOAD_PATH,
  CONVEX_STORAGE_PATH,
  storageIdFromPath,
} from '../../core/src/attachment-download.ts'

const STORAGE_HEADERS = [
  'accept-ranges',
  'content-encoding',
  'content-length',
  'content-range',
  'content-type',
  'digest',
] as const

type DownloadRequest = {
  storageUrl: URL
  filename: string
  method: 'GET' | 'HEAD'
}

/** Serves native attachment downloads on the existing frontend listener. */
export function attachmentDownloads(convexInternalUrl: string): Plugin {
  const middleware = attachmentDownloadMiddleware(convexInternalUrl)
  return {
    name: 'attachment-downloads',
    configureServer(server) {
      server.middlewares.use(middleware)
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware)
    },
  }
}

function attachmentDownloadMiddleware(
  convexInternalUrl: string,
): Connect.NextHandleFunction {
  return (incoming, response, next) => {
    const [path, ...query] = (incoming.url ?? '').split('?')
    if (!path.startsWith(ATTACHMENT_DOWNLOAD_PATH)) return next()

    const { method } = incoming
    if (method !== 'GET' && method !== 'HEAD') {
      response.setHeader('Allow', 'GET, HEAD')
      response.writeHead(405).end()
      return
    }

    const id = storageIdFromPath(path, ATTACHMENT_DOWNLOAD_PATH)
    if (!id) {
      response.writeHead(404).end()
      return
    }

    const params = new URLSearchParams(query.join('?'))
    const storageUrl = new URL(CONVEX_STORAGE_PATH + id, convexInternalUrl)
    const component = params.get('component')
    if (component) storageUrl.searchParams.set('component', component)

    relayDownload(incoming, response, {
      storageUrl,
      filename: params.get('filename') ?? '',
      method,
    })
  }
}

function relayDownload(
  incoming: IncomingMessage,
  response: ServerResponse,
  { storageUrl, filename, method }: DownloadRequest,
) {
  // The storage URL identifies an immutable file within this deployment.
  const hash = createHash('sha256').update(storageUrl.href).digest('hex')
  const etag = `"${hash}"`
  const ifRange = incoming.headers['if-range']
  const range = !ifRange || ifRange === etag ? incoming.headers.range : undefined // prettier-ignore
  const controller = new AbortController()

  response.once('close', () => {
    if (!response.writableFinished) controller.abort()
  })

  const upstream = request(
    storageUrl,
    {
      method,
      signal: controller.signal,
      headers: range ? { range } : undefined,
    },
    (source) => sendDownload(source, response, filename, etag),
  )
  upstream.once('error', () => {
    if (!response.destroyed && !response.headersSent)
      response.writeHead(502).end()
  })
  upstream.end()
}

function sendDownload(
  source: IncomingMessage,
  response: ServerResponse,
  filename: string,
  etag: string,
) {
  const status = source.statusCode ?? 502
  if (status !== 200 && status !== 206) {
    const range = source.headers['content-range']
    if (status === 416 && range) response.setHeader('Content-Range', range)
    source.destroy()
    response.writeHead(status >= 400 && status <= 599 ? status : 502).end()
    return
  }

  for (const header of STORAGE_HEADERS) {
    const value = source.headers[header]
    if (value !== undefined) response.setHeader(header, value)
  }
  response.setHeader('Cache-Control', 'private, no-cache')
  response.setHeader('Content-Disposition', downloadDisposition(filename))
  response.setHeader('ETag', etag)
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.writeHead(status)
  pipeline(source, response, () => {
    // Pipeline destroys both streams if either connection breaks.
  })
}

function downloadDisposition(filename: string) {
  const cleaned = Array.from(filename, (character) => {
    const code = character.charCodeAt(0)
    const unsafe = code < 32 || code === 127 || '/\\'.includes(character)
    return unsafe ? '_' : character
  })
    .join('')
    .trim()
  const name =
    !cleaned || cleaned === '.' || cleaned === '..' ? 'attachment' : cleaned
  const ascii = name.replace(/[^ -~]|["%]/g, '_')
  const encoded = encodeURIComponent(name).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  )

  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`
}
