import { type Page, expect, test } from '@playwright/test'

function watchTranscriptGap(page: Page) {
  return page.evaluateHandle(() => {
    const transcript = document.querySelector(
      '[data-slot="transcript-window"]',
    )!
    const composer = document.querySelector('[data-slot="chat-box"]')!
    const gaps: number[] = []
    const sample = () => {
      gaps.push(
        composer.getBoundingClientRect().top -
          transcript.getBoundingClientRect().bottom,
      )
    }
    const observer = new ResizeObserver(sample)
    observer.observe(transcript)
    observer.observe(composer)
    sample()
    return () => {
      observer.disconnect()
      sample()
      return Math.max(...gaps) - Math.min(...gaps)
    }
  })
}

function waitForBottom(page: Page) {
  return expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollHeight - scrollY - innerHeight,
      ),
    )
    .toBeLessThanOrEqual(1)
}

test('keeps the transcript against the dock when discarding a pending attachment send', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 780 })
  await page.route('**/composer-upload', (route) =>
    route.fulfill(
      route.request().headers()['content-type'] === 'application/zip'
        ? { status: 500 }
        : { json: { storageId: 'staged' } },
    ),
  )
  await page.goto('/?fixture=subagent-approvals&id=parent&deferSend&history')
  await page.locator('input[name="attachment"]').setInputFiles([
    {
      name: 'screen.png',
      mimeType: 'image/png',
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOh0AAAAASUVORK5CYII=',
        'base64',
      ),
    },
    {
      name: 'data.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from('zip'),
    },
  ])
  const composer = page.locator('[data-slot="chat-box"]')
  await composer.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(composer.locator('[data-slot="file-strip"]')).toHaveCount(0)
  const attachment = page.locator('[data-slot="file-block"]')
  await expect(attachment.getByText('Upload failed (HTTP 500)')).toBeVisible()
  const discard = attachment.getByRole('button', { name: 'Discard message' })
  await expect(discard).toBeInViewport()
  await waitForBottom(page)
  const gap = await watchTranscriptGap(page)
  await discard.click()
  await expect(attachment).toHaveCount(0)
  await waitForBottom(page)
  expect(await gap.evaluate((stop) => stop())).toBeLessThanOrEqual(2)
})

test('keeps the transcript against the dock when deleting above a taller tail row', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 780 })
  await page.goto('/?fixture=notes&id=notes&composer')
  const editor = page.locator('[data-slot="chat-box"] [contenteditable="true"]')
  const message = 'Short message to delete'
  const tail = `${'A line of text that will wrap. '.repeat(25)}Tail message`
  for (const text of [message, tail]) {
    await editor.fill(text)
    await editor.press('Enter')
    await expect(editor).toHaveText('')
  }
  await expect(page.getByText(/Tail message$/)).toBeVisible()
  await waitForBottom(page)
  await expect(page.locator('[data-slot="transcript-window"]')).toHaveCSS(
    'pointer-events',
    'auto',
  )

  const row = page.getByText(message, { exact: true })
  await expect(row).toBeInViewport({ ratio: 1 })
  await row.click({ button: 'right' })
  await page
    .getByRole('menuitem', { name: 'Delete Message', exact: true })
    .click()
  const confirm = page
    .getByRole('alertdialog')
    .getByRole('button', { name: 'Delete', exact: true })
  const gap = await watchTranscriptGap(page)
  await confirm.click()
  await expect(row).toHaveCount(0)
  await waitForBottom(page)
  expect(await gap.evaluate((stop) => stop())).toBeLessThanOrEqual(2)
})

test('keeps the selected message line in place as the mobile viewport shrinks', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 780 })
  await page.goto('/?fixture=notes&id=notes&keyboardEdit')
  const message = page.locator(
    '[data-row-kind="group"][data-message-id="keyboard-edit"]',
  )
  const text = 'Message paragraph 28'
  const line = message.getByText(text, { exact: true })
  await line.scrollIntoViewIfNeeded()
  await line.evaluate((el) =>
    window.scrollBy(0, el.getBoundingClientRect().top - 210),
  )
  const before = (await line.boundingBox())!.y
  await line.click({ button: 'right', position: { x: 48, y: 10 } })
  await page.getByRole('menuitem', { name: 'Edit Message' }).click()
  const editor = message.locator('[data-slot="editor"]')
  await expect(editor).toBeFocused()
  await page.setViewportSize({ width: 390, height: 460 })
  const save = page.getByRole('button', { name: 'Save edit' })
  await expect(save).toBeInViewport({ ratio: 1 })
  await expect
    .poll(() =>
      save.evaluate((el) => innerHeight - el.getBoundingClientRect().bottom),
    )
    .toBeLessThan(80)

  const editedLine = editor.getByText(text, { exact: true })
  await expect
    .poll(async () => Math.abs((await editedLine.boundingBox())!.y - before))
    .toBeLessThanOrEqual(2)
  const selectionText = await editor.evaluate(
    () => document.getSelection()?.anchorNode?.textContent,
  )
  expect(selectionText).toContain(text)
})

test('keeps the focused composer and bottom fade above the resized mobile viewport', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 780 })
  await page.goto('/?fixture=notes&id=notes&composer')
  const composer = page.locator(
    '[data-slot="chat-box"] [contenteditable="true"]',
  )
  await expect(composer).toBeInViewport({ ratio: 1 })
  await composer.click()
  await expect(composer).toBeFocused()

  const dock = page.locator('[data-slot="chat-dock"]')
  const fade = dock.locator('..').locator(':scope > div > [aria-hidden="true"]')
  for (const height of [460, 390, 780]) {
    await page.setViewportSize({ width: 390, height })
    await expect(composer).toBeInViewport({ ratio: 1 })
    await expect
      .poll(() => fade.evaluate((el) => el.getBoundingClientRect().bottom))
      .toBeCloseTo(height, 0)
  }
})

test('preserves the dock height and scroll position in fullscreen', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 640 })
  await page.goto('/?fixture=notes&id=notes&composer')
  const expand = page.getByRole('button', { name: 'Full screen', exact: true })
  await expect(expand).toBeInViewport()
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
  await waitForBottom(page)

  const dock = page.locator('[data-slot="chat-dock"]')
  const dockHeight = () =>
    dock.evaluate((el) => el.getBoundingClientRect().height)
  const scrollPosition = () => page.evaluate(() => scrollY)
  const height = await dockHeight()
  const position = await scrollPosition()
  expect(position).toBeGreaterThan(0)

  await expand.click()
  const expanded = page.getByRole('dialog', { name: 'Expanded editor' })
  await expect(expanded).toBeVisible()
  expect(await dockHeight()).toBe(height)
  expect(await scrollPosition()).toBe(position)

  await expanded.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(expanded).toBeHidden()
  expect(await dockHeight()).toBe(height)
  expect(await scrollPosition()).toBe(position)
})

test('keeps following the bottom across consecutive keyboard sends', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 640 })
  await page.goto('/?fixture=notes&id=notes&composer')
  const editor = page.locator('[data-slot="chat-box"] [contenteditable="true"]')
  await expect(editor).toBeInViewport()

  for (let index = 0; index < 3; index++) {
    const marker = `Message ${index} end`
    await editor.fill(
      `${'A line of text that will wrap. '.repeat(90)}${marker}`,
    )
    await editor.press('Enter')
    await expect(editor).toHaveText('')
    await expect(page.getByText(marker, { exact: false })).toBeAttached()
    await waitForBottom(page)
  }
})

test('into-view mode aligns the submitted message beneath the navigation', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 640 })
  await page.goto('/?fixture=notes&id=notes&composer&intoView')
  const editor = page.locator('[data-slot="chat-box"] [contenteditable="true"]')
  await expect(editor).toBeInViewport()
  await editor.fill(
    `${'A line of text that will wrap. '.repeat(90)}Sent message`,
  )
  await editor.press('Enter')

  const firstRow = page.locator('[data-message-id="sent-32"]').first()
  await expect
    .poll(async () => Math.round((await firstRow.boundingBox())?.y ?? -1))
    .toBe(64)
})
