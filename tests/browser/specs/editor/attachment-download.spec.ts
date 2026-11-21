import { type Locator, expect, test } from '@playwright/test'
import { buffer } from 'node:stream/consumers'
import sharp from 'sharp'

const cors = { 'Access-Control-Allow-Origin': '*' }
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOh0AAAAASUVORK5CYII=',
  'base64',
)

test('copies and pastes public links, opens previews, and downloads originals by name', async ({
  page,
  context,
}) => {
  const fileUrl = 'https://storage.example.test/api/storage/image'
  const pdf = Buffer.from('%PDF-1.7 card')
  await context.route(fileUrl, (route) =>
    route.fulfill({ headers: cors, contentType: 'image/png', body: png }),
  )
  await page.route('https://storage.example.test/published-pdf', (route) =>
    route.fulfill({ headers: cors, contentType: 'application/pdf', body: pdf }),
  )
  await page.addInitScript(() => {
    let clipboard = ''
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: async (value: string) => {
          clipboard = value
        },
        readText: async () => clipboard,
      },
    })
  })
  await page.goto('/?fixture=attachment-download')

  await page.getByRole('button', { name: 'Copy link to image.png' }).click()
  const copied = await page.evaluate(() => navigator.clipboard.readText())
  expect(copied).toBe(fileUrl + '#attachment=image')

  const composer = page.getByRole('region', { name: 'Receiving session' })
  const editor = composer.locator('[data-slot="editor"]')
  await paste(editor, copied)
  await expect(composer.getByRole('img', { name: 'image.png' })).toBeVisible()
  await expect(editor).toHaveText('')
  await page.getByRole('button', { name: 'Send', exact: true }).click()

  const message = page.getByTestId('sent-message')
  await expect(message).toHaveText('')
  await expect(message.getByRole('link')).toHaveCount(0)
  await message.getByRole('button', { name: 'Open image.png' }).click()
  const gallery = page.getByRole('dialog', { name: 'Media viewer' })
  await expect(
    gallery.getByRole('img', { name: 'image.png' }),
  ).toHaveJSProperty('naturalWidth', 1)
  await page.keyboard.press('Escape')
  await expect(gallery).toBeHidden()

  const cases = [
    {
      control: page.getByRole('button', { name: 'Download processed.pdf' }),
      filename: 'processed.pdf',
      bytes: pdf,
    },
    {
      control: message.getByRole('button', { name: 'Download image.png' }),
      filename: 'image.png',
      bytes: png,
    },
  ]
  const url = page.url()
  for (const { control, filename: name, bytes } of cases) {
    const event = page.waitForEvent('download')
    await control.click()
    const download = await event

    expect(download.suggestedFilename()).toBe(name)
    expect(await buffer(await download.createReadStream())).toEqual(bytes)
    expect(page.url()).toBe(url)
    expect(context.pages()).toHaveLength(1)
  }
})

test('converts mixed pastes and leaves unmatched URLs editable', async ({
  page,
}) => {
  const fileUrl = 'https://storage.example.test/api/storage/image'
  await page.route(fileUrl, (route) =>
    route.fulfill({ headers: cors, contentType: 'image/png', body: png }),
  )
  await page.goto('/?fixture=attachment-download')
  const composer = page.getByRole('region', { name: 'Receiving session' })
  const editor = composer.locator('[data-slot="editor"]')
  const forged = fileUrl.replace('/image', '/wrong') + '#attachment=image'
  const shared = fileUrl + '#attachment=image'
  await paste(editor, forged)
  await expect(editor).toHaveText(forged)
  const card = composer.getByRole('button', { name: 'Remove file image.png' })
  await expect(card).toHaveCount(0)
  await page.keyboard.press('ControlOrMeta+a')
  await paste(editor, `See ${shared} and ${shared} today. Also ${fileUrl}`)
  await expect(editor).toHaveText(`See and today. Also ${fileUrl}`)
  await expect(composer.getByRole('img', { name: 'image.png' })).toHaveCount(1)
  await card.click()
  await expect(card).toHaveCount(0)
  await expect(editor).toHaveText(`See and today. Also ${fileUrl}`)
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

async function paste(editor: Locator, value: string) {
  await editor.evaluate((node, text) => {
    node.focus()
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', text)
    node.dispatchEvent(
      new ClipboardEvent('paste', { bubbles: true, clipboardData }),
    )
  }, value)
}
