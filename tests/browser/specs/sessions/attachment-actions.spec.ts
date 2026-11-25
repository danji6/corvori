import { expect, test } from '@playwright/test'
import type { Locator } from '@playwright/test'

const fixture = '/?fixture=notes&id=notes&composer&ungrouped&attachmentActions'
const fileRow =
  '[data-slot="message-row"][data-message-id="file-message"]:has([data-slot="file-block"])'
const singleRow =
  '[data-slot="message-row"][data-message-id="single-attachment"]:has([data-slot="file-block"])'
const thumbnail = '[data-slot="reply-attachment-thumbnail"]'

test.beforeEach(async ({ page }) => {
  await page.route('https://storage.example.test/*.png', (route) =>
    route.fulfill({
      contentType: 'image/png',
      body: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOh0AAAAASUVORK5CYII=',
        'base64',
      ),
    }),
  )
})

async function attachmentLayout(strip: Locator) {
  return strip.evaluate((element) => {
    const row = element.closest<HTMLElement>('[data-slot="virtualized-item"]')!
    const next = row.nextElementSibling as HTMLElement
    const rowHeight = row.getBoundingClientRect().height
    return {
      lines: new Set(
        Array.from(element.children, (item) => (item as HTMLElement).offsetTop),
      ).size,
      overflow: element.scrollWidth - element.clientWidth,
      rowHeight,
      followingRowOffset: next.offsetTop - row.offsetTop,
      transcriptHeight: row.parentElement!.getBoundingClientRect().height,
    }
  })
}

async function measuredAttachmentLayout(strip: Locator, lines: number) {
  await expect
    .poll(async () => {
      const layout = await attachmentLayout(strip)
      return {
        lines: layout.lines,
        overflow: layout.overflow,
        gap: Math.abs(layout.followingRowOffset - layout.rowHeight),
      }
    })
    .toEqual({ lines, overflow: 0, gap: 0 })
  return attachmentLayout(strip)
}

test('loads large text in portions and starts fresh when reopened', async ({
  page,
}) => {
  const pageBytes = 64 * 1024
  const first = 'const start = 1\n/*\n'
  const prefix = first.padEnd(pageBytes - 2, 'build output\n')
  const middle = '☀️ next portion'
  const suffix = 'end of build'
  const rest = `${middle}\n*/\n`.padEnd(pageBytes, '// build output\n')
  const content = prefix + rest + suffix
  const middleLine = prefix.split('\n').length

  const ready = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
  let requests = 0
  await page.route('https://storage.example.test/build.ts', async (route) => {
    await ready[requests++]?.promise
    await route.fulfill({
      contentType: 'text/plain',
      headers: { 'access-control-allow-origin': '*' },
      body: content,
    })
  })

  await page.goto(`${fixture}&textAttachment`)
  const trigger = page.getByRole('button', { name: 'Preview build.ts' })
  const dialog = page.getByRole('dialog', { name: 'build.ts' })
  const text = dialog.getByLabel('Attachment text')
  const loading = dialog.getByRole('progressbar', { name: 'Loading' })
  const loadMore = dialog.getByRole('button', { name: 'Load more' })
  const notice = dialog.getByRole('status')
  const numbers = text.locator('[data-slot="attachment-preview-line-number"]')
  const marker = text.getByText('... [truncated]', { exact: true })
  const highlightedMiddle = text
    .locator('code span')
    .filter({ hasText: middle })
  const scrollToEnd = () =>
    text.evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })

  try {
    await trigger.click()
    await expect(loading).toBeVisible()
    ready[0].resolve()
    await expect(notice).toContainText('too large to preview all at once')
    await expect(text).toContainText('const start = 1')
    await expect(numbers.first()).toHaveText('1')
    await expect(
      text.locator('code span').filter({ hasText: /^const$/ }),
    ).toBeVisible()
    expect(await numbers.count()).toBeLessThan(150)

    await scrollToEnd()
    await expect(marker).toBeInViewport()
    await expect(marker.locator('..').locator('code')).toHaveText(
      prefix.split('\n').at(-1)!,
    )

    await loadMore.click()
    await expect(notice).toContainText('128.0 KiB')
    await text.evaluate((element, line) => {
      element.scrollTop = (line - 1) * 18
    }, middleLine)
    await expect(highlightedMiddle).toHaveCSS('font-style', 'italic')
    await expect(
      highlightedMiddle
        .locator('../..')
        .locator('[data-slot="attachment-preview-line-number"]'),
    ).toHaveText(String(middleLine))
    await expect(highlightedMiddle.locator('../..')).not.toContainText(
      '... [truncated]',
    )
    await scrollToEnd()
    await expect(marker).toBeInViewport()
    expect(requests).toBe(1)

    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(page.getByLabel('Attachment text')).toHaveCount(0)
    await expect(dialog).toBeHidden()
    await trigger.click()
    await expect(loading).toBeVisible()
    await expect(text).toHaveCount(0)
    ready[1].resolve()
    await expect(loadMore).toBeVisible()
    await expect(notice).toContainText('64.0 KiB')
    await expect(text).toContainText('const start = 1')
    await expect(numbers.first()).toHaveText('1')
    await loadMore.click()
    await expect(notice).toContainText('128.0 KiB')
    await loadMore.click()
    await expect(loadMore).toHaveCount(0)
    await scrollToEnd()
    await expect(text).toContainText(suffix)
    await expect(marker).toHaveCount(0)
    expect(requests).toBe(2)
  } finally {
    for (const request of ready) request.resolve()
  }
})

test('remeasures wrapped attachments after resizing and removal', async ({
  page,
}) => {
  const preview = Promise.withResolvers<void>()
  await page.route(
    'https://storage.example.test/first-preview.png',
    async (route) => {
      await preview.promise
      await route.fallback()
    },
  )
  await page.route('https://storage.example.test/report.pdf', (route) =>
    route.fulfill({ contentType: 'application/pdf', body: '%PDF-1.7' }),
  )

  const strip = page.locator(fileRow).locator('[data-slot="file-block"]')
  const image = strip.getByRole('img', { name: 'first.png' })
  const report = strip.getByRole('link', { name: /^Open project-report/ })
  let wide
  try {
    await page.goto(`${fixture}&wrappedAttachments`)
    await expect(
      strip.locator('[data-attachment-name="first.png"]'),
    ).toBeVisible()
    await expect(report).toContainText('2.0 KiB')
    await expect(image).toHaveCount(0)
    wide = await measuredAttachmentLayout(strip, 1)
  } finally {
    preview.resolve()
  }
  await expect(image).toBeVisible()
  await expect.poll(() => attachmentLayout(strip)).toEqual(wide)

  const narrowColumn =
    '.chat-transcript-column { max-width: 280px !important; }'
  const widthLimit = await page.addStyleTag({ content: narrowColumn })
  const narrow = await measuredAttachmentLayout(strip, 2)
  expect(narrow.rowHeight).toBeGreaterThan(wide.rowHeight)
  expect(narrow.transcriptHeight - wide.transcriptHeight).toBe(
    narrow.rowHeight - wide.rowHeight,
  )

  await widthLimit.evaluate((style) => style.parentNode?.removeChild(style))
  await expect.poll(() => attachmentLayout(strip)).toEqual(wide)

  await page.addStyleTag({ content: narrowColumn })
  await expect.poll(() => attachmentLayout(strip)).toEqual(narrow)
  await image.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).hover()
  await page.getByRole('menuitem', { name: 'Delete Attachment' }).click()
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: 'Delete', exact: true })
    .click()
  await expect(image).toHaveCount(0)
  await expect(report).toBeVisible()

  const removed = await measuredAttachmentLayout(strip, 1)
  expect(removed.rowHeight).toBeLessThan(wide.rowHeight)
  expect(narrow.transcriptHeight - removed.transcriptHeight).toBe(
    narrow.rowHeight - removed.rowHeight,
  )
})

test('a guest can reply to an attachment-only message from every menu surface', async ({
  page,
}) => {
  await page.goto(`${fixture}&attachmentGuest`)
  const row = page.locator(fileRow)
  const first = row.getByRole('img', { name: 'first.png' })
  const menu = page.getByRole('menu')

  await first.click({ button: 'right' })
  await expect(menu.getByRole('menuitem')).toHaveText([
    'Download',
    'Copy Link',
    'Reply',
  ])
  await page.keyboard.press('Escape')

  const sender = page
    .locator('[data-slot="message-row"][data-message-id="file-message"]')
    .locator('[data-slot="avatar"]')
  await sender.click({ button: 'right' })
  await expect(menu.getByRole('menuitem')).toHaveText(['Reply'])
  await page.keyboard.press('Escape')

  await row.click({ button: 'right', position: { x: 350, y: 48 } })
  await expect(menu.getByRole('menuitem')).toHaveText(['Reply'])
  await menu.getByRole('menuitem', { name: 'Reply' }).click()
  const composer = page.locator('[data-slot="composer-reply"]')
  await expect(composer).toContainText('2 attachments')
  await expect(composer.locator(`${thumbnail} img`)).toHaveAttribute(
    'alt',
    'first.png',
  )
  await page.locator('[data-slot="editor"]').fill('Thanks for the files')
  await page.getByRole('button', { name: 'Send', exact: true }).click()

  const quote = page
    .locator('[data-slot="reply-quote"]')
    .filter({ hasText: '2 attachments' })
  await expect(quote).toBeVisible()
  await expect(quote.locator(`${thumbnail} img`)).toHaveAttribute(
    'alt',
    'first.png',
  )
  const replyText = page.getByText('Thanks for the files', { exact: true })
  await expect(replyText).toBeVisible()
  await quote.click({ trial: true })
  const quoteRow = quote.locator('xpath=ancestor::*[@data-row-kind="reply"]')
  const bodyRow = replyText.locator(
    'xpath=ancestor::*[@data-slot="message-row"]',
  )
  const card = (await quote.boundingBox())!
  const above = (await quoteRow.boundingBox())!.y
  const below = (await bodyRow.boundingBox())!.y
  const cardBottom = card.y + card.height

  expect(card.y - above).toBeGreaterThan(2)
  expect(below - cardBottom).toBeGreaterThan(2)
  for (const y of [(above + card.y) / 2, (cardBottom + below) / 2]) {
    await page.mouse.click(card.x + card.width / 2, y, { button: 'right' })
    await expect(
      menu.getByRole('menuitem', { name: 'Copy Message' }),
    ).toBeVisible()
    await page.keyboard.press('Escape')
  }

  await quote.click()
  await expect(page.locator('[data-slot="message-highlight"]')).toBeVisible()
  await expect(first).toBeInViewport()
})

test('the gap between a caption and its attachments opens the whole message menu', async ({
  page,
}) => {
  await page.goto(fixture)
  const caption = page.getByText('Keep this caption', { exact: true })
  const textRow = caption.locator('xpath=ancestor::*[@data-slot="message-row"]')
  const attachments = page.locator(fileRow)
  await attachments.click({ trial: true })
  const text = (await textRow.boundingBox())!
  const files = (await attachments.boundingBox())!
  const textBottom = text.y + text.height
  expect(files.y - textBottom).toBeGreaterThan(2)

  await page.mouse.click(text.x + text.width / 2, (textBottom + files.y) / 2, {
    button: 'right',
  })
  const menu = page.getByRole('menu')
  await expect(
    menu.getByRole('menuitem', { name: 'Copy Message' }),
  ).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'Copy Link' })).toHaveCount(0)
  await expect(menu.getByRole('menuitem', { name: 'Download' })).toHaveCount(0)
  const highlight = page.locator('[data-slot="message-highlight"]')
  await expect(highlight).toBeVisible()
  const bounds = (await highlight.boundingBox())!
  expect(bounds.y).toBeLessThanOrEqual(text.y)
  expect(bounds.y + bounds.height).toBeGreaterThanOrEqual(
    files.y + files.height,
  )
})

test('a text-block reply shows the first file when the original is outside the loaded window', async ({
  page,
}) => {
  await page.goto(`${fixture}&unloadedReplyTarget`)
  await page.getByText('Keep this caption').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Reply' }).click()

  const composer = page.locator('[data-slot="composer-reply"]')
  await expect(composer).toContainText('Keep this caption')
  await expect(composer.locator(`${thumbnail} img`)).toHaveAttribute(
    'alt',
    'first.png',
  )
  await page.locator('[data-slot="editor"]').fill('Reply to caption')
  await page.getByRole('button', { name: 'Send', exact: true }).click()

  const quote = page.locator('[data-slot="reply-quote"]')
  await expect(quote).toContainText('Keep this caption')
  await expect(page.locator('[data-message-id="file-message"]')).toHaveCount(0)
  await expect(quote.locator(`${thumbnail} img`)).toHaveAttribute(
    'alt',
    'first.png',
  )
})

for (const filename of ['first.png', 'second.png']) {
  test(`deletes only ${filename} after confirmation`, async ({ page }) => {
    await page.goto(fixture)
    const selected = page.getByRole('img', { name: filename })
    const sibling = page.getByRole('img', {
      name: filename === 'first.png' ? 'second.png' : 'first.png',
    })
    const deleteMenu = page.getByRole('menuitem', {
      name: 'Delete',
      exact: true,
    })
    const deleteAttachment = page.getByRole('menuitem', {
      name: 'Delete Attachment',
    })
    const dialog = page.getByRole('alertdialog')

    await selected.click({ button: 'right' })
    await deleteMenu.hover()
    await expect(
      page.getByRole('menuitem', { name: 'Delete Message' }),
    ).toBeVisible()
    await deleteAttachment.click()
    await expect(dialog).toContainText('Delete attachment?')
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(selected).toBeVisible()
    await expect(sibling).toBeVisible()

    await selected.click({ button: 'right' })
    await deleteMenu.hover()
    await deleteAttachment.click()
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(selected).toHaveCount(0)
    await expect(sibling).toBeVisible()
    await expect(page.getByText('Keep this caption')).toBeVisible()
  })
}

test('opens the message menu just beyond the bottom and side of its highlight', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1200, height: 1000 })
  await page.goto(fixture)
  const row = page.locator(singleRow)
  const menu = page.getByRole('menu')
  const highlight = page.locator('[data-slot="message-highlight"]')

  await row.click({ button: 'right', position: { x: 350, y: 48 } })
  await expect(highlight).toBeVisible()
  const bounds = (await highlight.boundingBox())!
  const { x, y, width, height } = bounds
  const edgePoints = [
    { x: x + width / 2, y: y + height + 2 },
    { x: x + width + 2, y: y + height - 24 },
  ]

  for (const point of edgePoints) {
    await page.keyboard.press('Escape')
    await expect(highlight).toHaveCount(0)
    await page.mouse.click(point.x, point.y, { button: 'right' })
    await expect(menu.getByRole('menuitem')).toHaveText([
      'Reply',
      'Delete Message',
    ])
  }

  await page.keyboard.press('Escape')
  await page.mouse.click(x + width / 2, y + height + 12, { button: 'right' })
  await expect(menu).toHaveCount(0)
})

test('the full-message highlight and menu reach the background edges', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1200, height: 1000 })
  await page.goto(`${fixture}&backgrounds`)
  const background = page.locator(
    '[data-slot="message-background"][data-palette-message-id="single-attachment"]',
  )
  await page.locator(singleRow).click({ trial: true })
  const { x, y, width, height } = (await background.boundingBox())!
  const menu = page.getByRole('menu')
  const highlight = page.locator('[data-slot="message-highlight"]')
  const points = [
    { x: x + width / 2, y: y + 2 },
    { x: x + width / 2, y: y + height - 2 },
    { x: x + 2, y: y + height / 2 },
    { x: x + width - 2, y: y + height / 2 },
    { x: x + width - 8, y: y + 6 },
  ]

  for (const point of points) {
    await page.mouse.click(point.x, point.y, { button: 'right' })
    await expect(menu.getByRole('menuitem')).toHaveText([
      'Reply',
      'Delete Message',
    ])
    await expect
      .poll(() => highlight.boundingBox())
      .toEqual({ x, y, width, height })
    await page.keyboard.press('Escape')
  }
})

test('uses the attachment action for a sole file, even without a download URL', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1200, height: 1000 })
  await page.goto(fixture)
  const row = page.locator(singleRow)
  const preview = row.locator('[data-attachment-name="archive.pdf"]')
  const menu = page.getByRole('menu')

  await row.click({ button: 'right', position: { x: 350, y: 48 } })
  await expect(menu.getByRole('menuitem')).toHaveText([
    'Reply',
    'Delete Message',
  ])
  await preview.click({ button: 'right' })
  const highlight = page.locator('[data-slot="message-highlight"]')
  await expect(highlight).toBeVisible()
  const attachment = (await preview.boundingBox())!
  await expect
    .poll(async () => (await highlight.boundingBox())?.width ?? 0)
    .toBeCloseTo(attachment.width + 24, 0)
  const selection = (await highlight.boundingBox())!
  expect(attachment.x - selection.x).toBeCloseTo(12, 0)
  expect(attachment.y - selection.y).toBeCloseTo(12, 0)
  expect(selection.height - attachment.height).toBeCloseTo(24, 0)
  await menu.getByRole('menuitem', { name: 'Reply' }).click()
  const composer = page.locator('[data-slot="composer-reply"]')
  await expect(composer).toContainText('1 attachment')
  await expect(composer.getByRole('img', { name: 'archive.pdf' })).toBeVisible()
  await composer.getByRole('button', { name: 'Cancel reply' }).click()
  await expect(composer).toHaveCount(0)

  const deleteMenu = page.getByRole('menuitem', { name: 'Delete', exact: true })
  const dialog = page.getByRole('alertdialog')
  await preview.click({ button: 'right' })
  await deleteMenu.focus()
  await page.getByRole('menuitem', { name: 'Delete Message' }).click()
  await expect(dialog).toContainText('Delete this message?')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toBeHidden()

  await preview.click({ button: 'right' })
  await deleteMenu.focus()
  await page.getByRole('menuitem', { name: 'Delete Attachment' }).click()
  await expect(dialog).toContainText('Delete attachment?')
  await expect(dialog).toContainText(
    'Deleting it will also delete the message.',
  )
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(
    page.locator('[data-message-id="single-attachment"]'),
  ).toHaveCount(0)
})
