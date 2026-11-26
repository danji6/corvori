import {
  ATTACHMENT_DOWNLOAD_PATH,
  CONVEX_STORAGE_PATH,
} from '@cv/core/attachment-download'
import { type Locator, type Page, expect, test } from '@playwright/test'
import { execFileSync, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buffer } from 'node:stream/consumers'
import { fileURLToPath } from 'node:url'
import { preview } from 'vite'
import { attachmentDownloads } from '~/packages/client/server/attachment-downloads'
import {
  nativeImage,
  nativePdf,
} from '~/tests/browser/attachment-download-assets'

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOh0AAAAASUVORK5CYII=',
  'base64',
)
const pdf = Buffer.concat([
  Buffer.from('%PDF-1.7 fixture\n'),
  Buffer.alloc(8 * 1024 * 1024, 0x2a),
])
const files = {
  [nativeImage.id]: { bytes: png, mediaType: nativeImage.mediaType },
  [nativePdf.id]: { bytes: pdf, mediaType: nativePdf.mediaType },
}
const failedId = '00000000-0000-0000-0000-000000000001'
const missingId = '00000000-0000-0000-0000-000000000002'
const previewRoot = fileURLToPath(new URL('../../', import.meta.url))
const firstChunkSize = 64 * 1024

type Transfer = {
  finish: () => void
  closed: Promise<void>
}

/** Sends one chunk and holds the rest until the browser test releases it. */
function storageFixture() {
  const transfers: Transfer[] = []
  const requests: string[] = []
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    requests.push(url.pathname)
    const id = url.pathname.slice(CONVEX_STORAGE_PATH.length)
    if (id === failedId) {
      response.writeHead(503).end('Upstream unavailable')
      return
    }
    const file = files[id]
    if (!file) {
      response.writeHead(404).end('File missing')
      return
    }

    const { bytes, mediaType } = file
    const range = /^bytes=(\d+)-$/.exec(request.headers.range ?? '')
    const start = range ? Number(range[1]) : 0
    if (start >= bytes.length) {
      response
        .writeHead(416, { 'Content-Range': `bytes */${bytes.length}` })
        .end()
      return
    }

    response.setHeader('Content-Type', mediaType)
    response.setHeader('Content-Length', bytes.length - start)
    response.setHeader('Accept-Ranges', 'bytes')
    if (range) {
      response.setHeader(
        'Content-Range',
        `bytes ${start}-${bytes.length - 1}/${bytes.length}`,
      )
    }
    response.writeHead(range ? 206 : 200)
    if (request.method === 'HEAD') {
      response.end()
    } else if (range || id === nativeImage.id) {
      response.end(bytes.subarray(start))
    } else {
      const closed = once(response, 'close').then(() => undefined)
      transfers.push({
        finish: () => response.end(bytes.subarray(firstChunkSize)),
        closed,
      })
      response.write(bytes.subarray(0, firstChunkSize))
    }
  })
  return { server, transfers, requests }
}

function testingTls() {
  const directory = mkdtempSync(join(tmpdir(), 'corvori-download-tls-'))
  const key = join(directory, 'key.pem')
  const cert = join(directory, 'cert.pem')
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-nodes',
        '-keyout',
        key,
        '-out',
        cert,
        '-subj',
        '/CN=127.0.0.1',
        '-days',
        '1',
      ],
      { stdio: 'ignore' },
    )
    return { key: readFileSync(key), cert: readFileSync(cert) }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

const hasOpenSsl =
  spawnSync('openssl', ['version'], { stdio: 'ignore' }).status === 0

for (const protocol of ['http', 'https']) {
  test.describe(`native attachments over ${protocol}`, () => {
    test.skip(
      protocol === 'https' && !hasOpenSsl,
      'HTTPS fixture requires OpenSSL',
    )
    test.use({ ignoreHTTPSErrors: true })

    const nativeTest = test.extend<{
      relay: Omit<ReturnType<typeof storageFixture>, 'server'> & {
        origin: string
      }
    }>({
      relay: async ({ browserName: _browserName }, provide) => {
        const { server, transfers, requests } = storageFixture()
        server.listen(0, '127.0.0.1')
        await once(server, 'listening')
        const storagePort = (server.address() as AddressInfo).port
        try {
          const frontend = await preview({
            root: previewRoot,
            configFile: false,
            plugins: [attachmentDownloads(`http://127.0.0.1:${storagePort}`)],
            preview: {
              port: 0,
              host: '127.0.0.1',
              https: protocol === 'https' ? testingTls() : undefined,
            },
          })
          const port = (frontend.httpServer.address() as AddressInfo).port
          try {
            await provide({
              origin: `${protocol}://127.0.0.1:${port}`,
              transfers,
              requests,
            })
          } finally {
            await frontend.close()
          }
        } finally {
          server.closeAllConnections()
          await new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()))
          })
        }
      },
    })

    nativeTest(
      'hands off original files before storage finishes sending',
      async ({ page, relay }) => {
        await openDownloadFixture(page, relay.origin)
        const originalPage = page.url()
        const image = await startDownload(
          page,
          page.getByRole('img', { name: nativeImage.name }),
        )
        expect(image.url()).toBe(downloadUrl(relay.origin, nativeImage))
        expect(image.suggestedFilename()).toBe(nativeImage.name)
        expect(await buffer(await image.createReadStream())).toEqual(png)

        const document = await startDownload(
          page,
          page.getByRole('link', { name: `Open ${nativePdf.name}` }),
        )
        expect(document.url()).toBe(downloadUrl(relay.origin, nativePdf))
        expect(document.suggestedFilename()).toBe(nativePdf.name)
        expect(relay.transfers).toHaveLength(1)
        relay.transfers[0].finish()
        expect(
          (await buffer(await document.createReadStream())).equals(pdf),
        ).toBe(true)
        expect(page.url()).toBe(originalPage)
        expect(page.context().pages()).toHaveLength(1)
      },
    )

    nativeTest(
      'aborts storage on cancel and serves the remaining byte range',
      async ({ page, relay }) => {
        await openDownloadFixture(page, relay.origin)
        const url = downloadUrl(relay.origin, nativePdf)
        const headers = await page.request.head(url)
        const etag = headers.headers().etag
        expect(etag).toBeTruthy()
        expect(headers.headers()['content-length']).toBe(String(pdf.length))

        const download = await startDownload(
          page,
          page.getByRole('link', { name: 'Inline attachment' }),
        )
        await download.cancel()
        await relay.transfers[0].closed
        expect(await download.failure()).toBeTruthy()

        const offset = firstChunkSize
        const range = { Range: `bytes=${offset}-`, 'If-Range': etag }
        const resumed = await page.request.get(url, { headers: range })
        expect(resumed.status()).toBe(206)
        expect(resumed.headers()['content-range']).toBe(
          `bytes ${offset}-${pdf.length - 1}/${pdf.length}`,
        )
        expect(resumed.headers().etag).toBe(etag)
        expect((await resumed.body()).equals(pdf.subarray(offset))).toBe(true)

        const stale = await page.request.head(url, {
          headers: { ...range, 'If-Range': '"stale"' },
        })
        expect(stale.status()).toBe(200)
        expect(stale.headers()['content-range']).toBeUndefined()
      },
    )

    nativeTest(
      'rejects invalid requests and forwards storage failures',
      async ({ request, relay }) => {
        const invalid = await request.get(
          downloadUrl(relay.origin, { id: 'not-a-uuid', name: 'wrong.pdf' }),
        )
        const unsupported = await request.post(
          downloadUrl(relay.origin, nativePdf),
        )
        expect(invalid.status()).toBe(404)
        expect(unsupported.status()).toBe(405)
        expect(relay.requests).toHaveLength(0)

        const unsatisfiable = await request.get(
          downloadUrl(relay.origin, nativePdf),
          {
            headers: { Range: `bytes=${pdf.length}-` },
          },
        )
        expect(unsatisfiable.status()).toBe(416)
        expect(unsatisfiable.headers()['content-range']).toBe(
          `bytes */${pdf.length}`,
        )
        expect(unsatisfiable.headers()['content-disposition']).toBeUndefined()

        for (const [id, status] of [
          [missingId, 404],
          [failedId, 503],
        ] as const) {
          const result = await request.get(
            downloadUrl(relay.origin, { id, name: nativePdf.name }),
          )
          expect(result.status()).toBe(status)
          expect(result.headers()['content-disposition']).toBeUndefined()
          expect(await result.text()).toBe('')
        }
      },
    )
  })
}

function downloadUrl(origin: string, file: { id: string; name: string }) {
  const url = new URL(ATTACHMENT_DOWNLOAD_PATH + file.id, origin)
  url.searchParams.set('filename', file.name)
  return url.href
}

async function openDownloadFixture(page: Page, origin: string) {
  await page.route(`**${CONVEX_STORAGE_PATH}${nativeImage.id}`, (route) =>
    route.fulfill({
      headers: { 'Access-Control-Allow-Origin': '*' },
      contentType: nativeImage.mediaType,
      body: png,
    }),
  )
  await page.goto(`${origin}/?fixture=attachment-download&native`)
}

async function startDownload(page: Page, target: Locator) {
  await target.click({ button: 'right' })
  return await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('menuitem', { name: 'Download', exact: true }).click(),
  ]).then(([download]) => download)
}
