import { type Locator, type Page, expect, test } from '@playwright/test'

const bounds = '[data-slot="message-background"]'
const tint = '[data-slot="message-background-tint"]'
const surface = (id: string) => `${bounds}[data-palette-message-id="${id}"]`
const row = (id: string, kind: string) =>
  `[data-slot="virtualized-item"][data-message-id="${id}"][data-row-kind="${kind}"]`

async function openTranscript(page: Page, query = '') {
  await page.goto(`/?fixture=notes&id=notes&backgrounds${query}`)
  await expect(page.locator(surface('work')).first()).toBeVisible()
  const viewport = page.viewportSize()!
  await page.mouse.move(viewport.width / 2, viewport.height / 2)
  await page.mouse.wheel(0, -1200)
  await expect(page.locator(row('work', 'header'))).toBeInViewport()
}

async function expectCentered(page: Page, message: Locator) {
  const layout = (await page
    .locator('[data-slot="chat-layout"]')
    .boundingBox())!
  const { x, width } = (await message.boundingBox())!
  expect(x - layout.x).toBeCloseTo(layout.x + layout.width - x - width, 0)
}

test('covers the work details, streamed text, and footer as one surface', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1200, height: 820 })
  await openTranscript(page)
  await page.addStyleTag({
    content: '[data-slot="chat-layout"] { margin-inline: 140px 24px; }',
  })
  const background = page.locator(surface('work'))
  const work = page.locator('[data-slot="work-block"]')
  const footer = page.locator(row('work', 'footer'))
  await expect(footer).toContainText('Worked for')
  await expect(background).toHaveCount(1)
  await expectCentered(page, background)
  await expectCentered(page, page.locator(surface('next')))
  const before = (await background.boundingBox())!
  const header = (await page.locator(row('work', 'header')).boundingBox())!
  const avatar = (await page
    .locator(row('work', 'header'))
    .locator('[data-slot="avatar"]')
    .boundingBox())!
  const headerContent = (await page
    .locator(row('work', 'header'))
    .locator('[data-slot="message-row"]')
    .boundingBox())!
  const footerBox = (await footer.boundingBox())!
  const footerContent = (await footer
    .locator('[data-slot="message-row"]')
    .boundingBox())!
  expect(headerContent.y - before.y).toBeCloseTo(24, 0)
  expect(
    footerBox.y + footerBox.height - footerContent.y - footerContent.height,
  ).toBeCloseTo(24, 0)
  expect(header.x - before.x).toBeCloseTo(20, 0)
  expect(avatar.x + avatar.width).toBeLessThan(before.x)
  expect(before.y).toBeCloseTo(header.y, 0)
  expect(before.y + before.height).toBeCloseTo(
    footerBox.y + footerBox.height,
    0,
  )
  const next = (await page.locator(surface('next')).boundingBox())!
  expect(next.y - before.y - before.height).toBeGreaterThan(20)

  await work.click()
  await expect
    .poll(async () => (await background.boundingBox())?.height)
    .toBeGreaterThan(before.height + 60)
  const expanded = (await background.boundingBox())!
  await page.evaluate(() =>
    window.dispatchEvent(new Event('stream-fixture-text')),
  )
  await expect
    .poll(async () => (await background.boundingBox())?.height)
    .toBeGreaterThan(expanded.height + 300)

  await page.mouse.wheel(0, 900)
  await expect(page.locator(row('work', 'header'))).toHaveCount(0)
  await expect(background).toBeInViewport()
  expect((await background.boundingBox())!.y).toBeLessThan(-500)
})

test('uses the sender palette in both modes and keeps highlights above the tint', async ({
  page,
}) => {
  await page.setViewportSize({ width: 460, height: 820 })
  await page.emulateMedia({ colorScheme: 'light' })
  await openTranscript(page)
  const background = page.locator(surface('work'))
  const color = background.locator(tint)
  await expect(color).toHaveCSS('--source-color', '#176b46')
  await expect(color).toHaveCSS('color-scheme', 'light')
  const light = await color.evaluate(
    (el) => getComputedStyle(el).backgroundColor,
  )
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(color).toHaveCSS('color-scheme', 'dark')
  await expect(color).not.toHaveCSS('background-color', light)
  const { x, width } = (await background.boundingBox())!
  expect(x).toBeGreaterThanOrEqual(0)
  expect(x + width).toBeLessThanOrEqual(461)
  await expectCentered(page, background)

  const text = page
    .getByText('Regression checks passed.', { exact: true })
    .first()
  await text.click({ button: 'right' })
  const highlight = page.locator('[data-slot="message-highlight"]')
  await expect(highlight).toBeVisible()
  await expect(highlight).toHaveCSS(
    'border-radius',
    await background.evaluate(
      (element) => getComputedStyle(element).borderRadius,
    ),
  )
  expect(
    await highlight.evaluate((el) =>
      el.previousElementSibling?.contains(
        document.querySelector('[data-slot="message-background"]'),
      ),
    ),
  ).toBe(true)
})

test('moves the avatar into the gutter only when the padded background fits', async ({
  page,
}) => {
  await page.setViewportSize({ width: 790, height: 1000 })
  await openTranscript(page)
  const header = page.locator(row('work', 'header'))
  const avatar = header.locator('[data-slot="avatar"]')
  const avatarOffset = async () =>
    (await avatar.boundingBox())!.x - (await header.boundingBox())!.x
  const background = page.locator(surface('work'))

  await expect.poll(avatarOffset).toBeGreaterThanOrEqual(0)
  expect((await avatar.boundingBox())!.x).toBeGreaterThan(
    (await background.boundingBox())!.x,
  )
  await expectCentered(page, background)
  await page.setViewportSize({ width: 860, height: 1000 })
  await expect
    .poll(async () => {
      const icon = (await avatar.boundingBox())!
      return (await background.boundingBox())!.x - icon.x - icon.width
    })
    .toBeGreaterThan(0)
  expect((await background.boundingBox())!.x).toBeGreaterThanOrEqual(8)
  await expectCentered(page, background)
})

async function sampleGutterChange(layout: Locator, width: number) {
  return layout.evaluate(
    (element, { width, backgroundSelector, headerSelector }) => {
      const background = element.querySelector(backgroundSelector)!
      const header = element.querySelector(headerSelector)!
      const avatar = header.querySelector('[data-slot="avatar"]')!
      const sample = () => {
        const bg = background.getBoundingClientRect()
        const icon = avatar.getBoundingClientRect()
        const pane = element.getBoundingClientRect()
        return {
          width: bg.width,
          avatarOffset: icon.x - header.getBoundingClientRect().x,
          centerOffset: bg.x + bg.width / 2 - (pane.x + pane.width / 2),
        }
      }

      const frames = [sample()]
      element.style.width = `${width}px`
      frames.push(sample())
      const transcript = background.closest('[data-slot="transcript-window"]')!
      const animations = transcript
        .parentElement!.getAnimations({ subtree: true })
        .map((animation) => ({
          animation,
          endTime: Number(animation.effect?.getComputedTiming().endTime),
        }))
        .filter(({ endTime }) => Number.isFinite(endTime))

      for (const progress of [0.25, 0.5, 0.75]) {
        for (const { animation, endTime } of animations) {
          animation.currentTime = progress * endTime
        }
        frames.push(sample())
      }
      for (const { animation } of animations) animation.finish()
      return [...frames, sample()]
    },
    {
      width,
      backgroundSelector: surface('work'),
      headerSelector: row('work', 'header'),
    },
  )
}

test('keeps the surface centered and fixed in width as the avatar moves', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 1000 })
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await openTranscript(page)
  const layout = page.locator('[data-slot="chat-layout"]')
  const avatar = page
    .locator(row('work', 'header'))
    .locator('[data-slot="avatar"]')
  await page.addStyleTag({
    content: '[data-slot="chat-layout"] { width: 790px; margin-inline: auto; }',
  })
  await expect(avatar).toHaveCSS('margin-left', '0px')

  for (const width of [860, 790]) {
    const frames = await sampleGutterChange(layout, width)
    const [first, resized, ...transition] = frames
    const last = frames.at(-1)!
    const minOffset = Math.min(first!.avatarOffset, last.avatarOffset)
    const maxOffset = Math.max(first!.avatarOffset, last.avatarOffset)
    expect(maxOffset - minOffset).toBeGreaterThan(40)
    expect(
      transition.some(
        (frame) =>
          frame.avatarOffset > minOffset + 2 &&
          frame.avatarOffset < maxOffset - 2,
      ),
    ).toBe(true)
    expect(
      Math.max(
        ...transition.map((frame) => Math.abs(frame.width - resized!.width)),
      ),
    ).toBeLessThan(0.5)
    expect(
      Math.max(...frames.map((frame) => Math.abs(frame.centerOffset))),
    ).toBeLessThan(0.5)
  }

  await page.emulateMedia({ reducedMotion: 'reduce' })
  const reduced = await sampleGutterChange(layout, 860)
  const [before, after] = reduced
  expect(before!.avatarOffset - after!.avatarOffset).toBeGreaterThan(40)
  expect(after!.avatarOffset).toBeCloseTo(reduced.at(-1)!.avatarOffset, 0)
})

test('persists the Appearance switch and removes the background layer', async ({
  page,
}) => {
  await openTranscript(page)
  await page.getByText('Appearance', { exact: true }).click()
  const toggle = page.getByRole('switch', { name: 'Message backgrounds' })
  await expect(toggle).toBeChecked()
  await toggle.click()
  await page.getByRole('button', { name: 'Save appearance' }).click()
  await expect(page.locator(bounds)).toHaveCount(0)

  await page.reload()
  await expect(page.locator(row('work', 'group')).first()).toBeVisible()
  await expect(page.locator(bounds)).toHaveCount(0)
  const text = page.locator(row('work', 'group')).first()
  await expectCentered(page, text.locator('[data-slot="message-row"]'))
  await page.getByText('Appearance', { exact: true }).click()
  await expect(toggle).not.toBeChecked()
})

test('leaves notes on the canvas and adds space when backgrounds are off', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1200, height: 1000 })
  await openTranscript(page, '&backgroundNotes')
  const surfaces = page.locator(surface('work'))
  const notes = page.locator('[data-slot="note-group-block"]')
  const noteRows = page.locator(
    '[data-row-kind="note-group"], [data-row-kind="hidden"]',
  )
  const lastNote = page.locator(row('skills', 'hidden'))
  await expect(surfaces).toHaveCount(2)
  const header = page.locator(row('work', 'header'))
  expect((await notes.boundingBox())!.x).toBeCloseTo(
    (await header.boundingBox())!.x,
    0,
  )

  async function expectClearBehindNotes() {
    const first = (await noteRows.first().boundingBox())!
    const last = (await noteRows.last().boundingBox())!
    const before = (await surfaces.first().boundingBox())!
    const after = (await surfaces.last().boundingBox())!
    expect(before.y + before.height).toBeLessThanOrEqual(first.y + 1)
    expect(after.y).toBeGreaterThanOrEqual(last.y + last.height - 1)
  }

  async function leadingGap() {
    const first = (await noteRows.first().boundingBox())!
    const label = (await notes.boundingBox())!
    return label.y - first.y
  }

  async function trailingGap(next: Locator) {
    const last = (await lastNote.boundingBox())!
    const following = (await next.boundingBox())!
    return following.y - last.y - last.height
  }

  await expectClearBehindNotes()
  await notes.click()
  await expect(lastNote.locator('[data-slot="hidden-chip"]')).toBeVisible()
  await expect(
    lastNote.locator('[data-slot="virtualized-row-transition"]'),
  ).not.toHaveAttribute('data-state')
  await expectClearBehindNotes()

  const before = await leadingGap()
  const after = await trailingGap(surfaces.last())
  await page.getByText('Appearance', { exact: true }).click()
  await page.getByRole('switch', { name: 'Message backgrounds' }).click()
  await page.getByRole('button', { name: 'Save appearance' }).click()
  await expect(surfaces).toHaveCount(0)
  const continuation = page
    .locator(row('continued', 'group'))
    .locator('[data-slot="message-row"]')
  await expect.poll(leadingGap).toBeGreaterThan(before)
  await expect.poll(() => trailingGap(continuation)).toBeGreaterThan(after)
})

test('uses the chat theme for summaries and leaves out their footer', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1200, height: 820 })
  await page.goto('/?fixture=notes&id=notes&backgrounds&compaction')
  const summary = page.locator('[data-slot="summary-block"]').first()
  await expect(summary).toBeInViewport()
  await expect(
    page.locator(
      `${bounds}:not([data-palette-message-id]), ${surface('summary')}`,
    ),
  ).toHaveCount(0)
  await expect(page.locator(row('summary', 'header'))).toHaveCount(0)
  await expect(page.locator(row('summary', 'footer'))).toHaveCount(0)

  await page.addStyleTag({
    content: '[data-slot="chat-layout"] { --source-color: #274cad; }',
  })
  const background = page.locator(bounds).last()
  await expect(background.locator(tint)).toHaveCSS('--source-color', '#176b46')
  await expect(summary).toHaveCSS('--source-color', '#274cad')

  const card = (await background.boundingBox())!
  const summaryBox = (await summary.boundingBox())!
  expect(summaryBox.x).toBeCloseTo(card.x, 0)
  expect(summaryBox.width).toBeCloseTo(card.width, 0)
})
