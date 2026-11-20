import { expect, test } from '@playwright/test'
import { buffer } from 'node:stream/consumers'
import sharp from 'sharp'

const cors = { 'Access-Control-Allow-Origin': '*' }
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOh0AAAAASUVORK5CYII=',
  'base64',
)

test('downloads original files from attachment buttons and Markdown links', async ({
  page,
  context,
}) => {
  const notes = '{"title":"Shared notes"}\n'

  await page.route('https://storage.example.test/image-original', (route) =>
    route.fulfill({ headers: cors, contentType: 'image/png', body: png }),
  )
  await page.route('**/attachments/notes/caf%C3%A9.json?resolve=1', (route) =>
    route.fulfill({
      headers: cors,
      json: { url: 'https://storage.example.test/notes-original' },
    }),
  )
  await page.route('https://storage.example.test/notes-original', (route) =>
    route.fulfill({
      headers: cors,
      contentType: 'application/json',
      body: notes,
    }),
  )
  const pdf = Buffer.from('%PDF-1.7 card')
  await page.route('https://storage.example.test/published-pdf', (route) =>
    route.fulfill({ headers: cors, contentType: 'application/pdf', body: pdf }),
  )
  await page.goto('/?fixture=attachment-download')
  const url = page.url()

  const cases = [
    {
      control: page.getByRole('button', { name: 'Download processed.pdf' }),
      filename: 'processed.pdf',
      bytes: pdf,
    },
    {
      control: page.getByRole('button', { name: 'Download image.png' }),
      filename: 'image.png',
      bytes: png,
    },
    {
      control: page.getByRole('link', { name: 'Shared notes' }),
      filename: 'café.json',
      bytes: Buffer.from(notes),
    },
  ]
  for (const { control, filename, bytes } of cases) {
    const event = page.waitForEvent('download')
    await control.click()
    const download = await event

    expect(download.suggestedFilename()).toBe(filename)
    expect(await buffer(await download.createReadStream())).toEqual(bytes)
    expect(page.url()).toBe(url)
    expect(context.pages()).toHaveLength(1)
  }
})

test('opens visible thumbnails and displays the selected preview while originals load', async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 600 })
  const originals = Promise.withResolvers<void>()
  const [firstPreview, firstOriginal, secondPreview, secondOriginal] =
    await Promise.all([
      solidPng(80, 100),
      solidPng(320, 400),
      solidPng(80, 120),
      solidPng(1200, 1800),
    ])
  await page.route('https://storage.example.test/*-preview.png', (route) =>
    route.fulfill({
      headers: cors,
      contentType: 'image/png',
      body: route.request().url().endsWith('first-preview.png')
        ? firstPreview
        : secondPreview,
    }),
  )
  await page.route(
    'https://storage.example.test/second-original.png',
    async (route) => {
      await originals.promise
      await route.fulfill({
        headers: cors,
        contentType: 'image/png',
        body: secondOriginal,
      })
    },
  )
  await page.route('https://storage.example.test/first-original.png', (route) =>
    route.fulfill({
      headers: cors,
      contentType: 'image/png',
      body: firstOriginal,
    }),
  )
  await page.goto('/?fixture=attachment-download&gallery')

  const first = page.getByRole('button', { name: 'Open first.png' })
  const second = page.getByRole('button', { name: 'Open second.png' })
  const firstThumb = first.getByRole('img')
  const secondThumb = second.getByRole('img')
  const dialog = page.getByRole('dialog', { name: 'Media viewer' })
  const preview = dialog.locator('[data-slot="lightbox-preview"]')
  const nextImage = dialog.getByRole('img', { name: 'second.png' })
  try {
    await expect(firstThumb).toHaveJSProperty('naturalWidth', 80)
    await expect(secondThumb).toHaveJSProperty('naturalWidth', 80)
    const secondSrc = await secondThumb.getAttribute('src')

    await first.click()
    const firstImage = dialog.getByRole('img', { name: 'first.png' })
    await expect(firstImage).toHaveJSProperty('naturalWidth', 320)

    await dialog.getByRole('button', { name: 'Next media' }).click()
    await expect(preview).toHaveAttribute('src', secondSrc!)
    await expect(preview).toHaveJSProperty('naturalWidth', 80)
    await expect(preview).toBeVisible()
    await expect(preview).toHaveCSS('filter', /blur\(/)
    await expect(preview).toHaveCSS('opacity', '1')
    await expect(nextImage).toHaveCSS('opacity', '0')
  } finally {
    originals.resolve()
  }

  await expect(nextImage).toHaveJSProperty('naturalWidth', 1200)
  await expect(nextImage).toHaveCSS('opacity', '1')
  await expect(preview).toHaveCount(0)
})

function solidPng(width: number, height: number) {
  return sharp({ create: { width, height, channels: 3, background: 'blue' } })
    .png()
    .toBuffer()
}
