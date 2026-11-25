import { expect, test } from '@playwright/test'

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
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollHeight - scrollY - innerHeight,
      ),
    )
    .toBeLessThanOrEqual(1)

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
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollHeight - scrollY - innerHeight,
        ),
      )
      .toBeLessThanOrEqual(1)
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
