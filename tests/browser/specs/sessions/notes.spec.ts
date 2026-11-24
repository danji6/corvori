import { type Locator, type Page, expect, test } from '@playwright/test'

const note = (page: Page, id: string) =>
  page.locator(`[data-slot="hidden-chip"][data-message-id="${id}"]`)
const group = (page: Page) => page.locator('[data-slot="note-group-block"]')

async function showGroup(page: Page) {
  await page.getByRole('button', { name: 'Group', exact: true }).click()
  await expect(group(page)).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Group', exact: true }),
  ).toHaveAttribute('data-seek-settled', 'true')
}

async function waitForGroupAnimation(page: Page) {
  const transition = page
    .locator(
      '[data-note-group-id="notes:mcp"] [data-slot="virtualized-row-transition"]',
    )
    .first()
  await expect(transition).toBeVisible()
  await expect(transition).not.toHaveAttribute('data-state')
}

async function expectAligned(page: Page, key: string) {
  await expect
    .poll(() =>
      page
        .locator(`[data-row-key="${key}"]`)
        .evaluate((el) => Math.abs(el.getBoundingClientRect().top - 64)),
    )
    .toBeLessThan(2)
}

async function sampleExpansion(trigger: Locator, childrenSelector: string) {
  return trigger.evaluate(async (button, selector) => {
    const mountedCounts: number[] = []
    ;(button as HTMLButtonElement).click()
    while (true) {
      await new Promise(requestAnimationFrame)
      const children = document.querySelectorAll(selector)
      const row = children[0]?.querySelector<HTMLElement>(
        '[data-slot="virtualized-row-transition"]',
      )
      if (!row) continue
      mountedCounts.push(children.length)
      if (!row.dataset.state) return mountedCounts
    }
  }, childrenSelector)
}

test.beforeEach(async ({ page }) => {
  await page.goto('/?fixture=notes&id=notes')
})

test('groups notes, expands independently with keyboard, and keeps state across virtualized remounts', async ({
  page,
}) => {
  await showGroup(page)
  await expect(group(page)).toHaveAttribute('aria-expanded', 'false')
  await expect(note(page, 'workspace')).toHaveCount(0)
  await group(page).focus()
  await page.keyboard.press('Enter')
  await waitForGroupAnimation(page)
  const workspace = note(page, 'workspace').getByRole('button')
  await expect(workspace).toHaveAttribute('aria-expanded', 'false')
  await expect(note(page, 'workspace').locator('strong')).toHaveCount(0)
  await workspace.focus()
  await page.keyboard.press('Space')
  await expect(note(page, 'workspace').locator('strong')).toHaveText(
    'Workspace details',
  )
  await expect(note(page, 'workspace')).toContainText('<system-reminder>')
  await expect(note(page, 'skills').getByRole('button')).toHaveAttribute(
    'aria-expanded',
    'false',
  )
  await group(page).click()
  await group(page).click()
  await expect(note(page, 'workspace').getByRole('button')).toHaveAttribute(
    'aria-expanded',
    'true',
  )
  await page.getByRole('button', { name: 'Top', exact: true }).click()
  await expect(note(page, 'workspace')).toHaveCount(0)
  await showGroup(page)
  await expect(note(page, 'workspace').getByRole('button')).toHaveAttribute(
    'aria-expanded',
    'true',
  )
  await page.getByRole('button', { name: 'Append', exact: true }).click()
  await expect(group(page)).toHaveAccessibleName('Collapse 5 notes')
  await expect(note(page, 'workspace').getByRole('button')).toHaveAttribute(
    'aria-expanded',
    'true',
  )
  await note(page, 'extra').getByRole('button').click()
  await expect(note(page, 'extra')).toContainText('No content.')
})

test('animates the padding around a note as its panel opens and closes', async ({
  page,
}) => {
  await showGroup(page)
  await group(page).click()
  await waitForGroupAnimation(page)
  const trigger = note(page, 'mcp').getByRole('button')

  const opening = await sampleNotePadding(trigger)
  expect(opening.after).toBeGreaterThan(opening.before)
  expect(opening.animated, `Opening offsets: ${opening.samples}`).toBe(true)
  await expect(note(page, 'mcp')).toContainText('Content for mcp')

  const closing = await sampleNotePadding(trigger)
  expect(closing.before).toBeGreaterThan(closing.after)
  expect(closing.animated, `Closing offsets: ${closing.samples}`).toBe(true)
  expect(closing.after).toBe(opening.before)
  await expect(note(page, 'mcp')).not.toContainText('Content for mcp')
})

function sampleNotePadding(trigger: Locator) {
  return trigger.evaluate(async (button) => {
    const surface = button.closest('[data-open]')!
    const measure = () =>
      button.getBoundingClientRect().top - surface.getBoundingClientRect().top
    const samples = [measure()]
    ;(button as HTMLButtonElement).click()
    do {
      await new Promise(requestAnimationFrame)
      samples.push(measure())
    } while (
      surface
        .getAnimations()
        .some((animation) => animation.playState === 'running')
    )
    const before = samples[0]!
    const after = samples.at(-1)!
    const min = Math.min(before, after)
    const max = Math.max(before, after)
    const animated = samples.some(
      (position) => position > min && position < max,
    )
    return { before, after, animated, samples }
  })
}

test('seeks a non-first note, restores its position after reload, and can target the first note', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Seek workspace' }).click()
  await expect(group(page)).toHaveAttribute('aria-expanded', 'true')
  await expect(note(page, 'workspace').getByRole('button')).toHaveAttribute(
    'aria-expanded',
    'true',
  )
  await expectAligned(page, 'hid:workspace')
  await page.evaluate(() => window.dispatchEvent(new Event('scroll')))
  await expect
    .poll(() =>
      page.evaluate(() => {
        window.dispatchEvent(new Event('scroll'))
        return Object.values(localStorage).some((value) =>
          value.includes('"rowKey":"hid:workspace"'),
        )
      }),
    )
    .toBe(true)
  await page.reload()
  await expect(note(page, 'workspace').getByRole('button')).toHaveAttribute(
    'aria-expanded',
    'true',
  )
  await expectAligned(page, 'hid:workspace')
  await page.getByRole('button', { name: 'Seek first' }).click()
  await expectAligned(page, 'hid:mcp')
  await expect(note(page, 'mcp')).toContainText('Content for mcp')
})

test('virtualizes expanded notes and makes closing rows inert', async ({
  page,
}) => {
  await page.goto('/?fixture=notes&id=notes&extraNotes=500')
  await showGroup(page)
  const children = page.locator('[data-note-group-id="notes:mcp"]')
  const transition = children
    .first()
    .locator('[data-slot="virtualized-row-transition"]')
  const firstOpen = await sampleExpansion(
    group(page),
    '[data-note-group-id="notes:mcp"]',
  )
  expect(Math.max(...firstOpen)).toBeLessThan(504)
  await group(page).click()
  await expect(transition).toHaveAttribute('inert')
  await expect(children).toHaveCount(0)
  await group(page).click()
  await expect(note(page, 'workspace').getByRole('button')).toHaveAttribute(
    'aria-expanded',
    'false',
  )
})

test('restores a collapsed header without expanding it', async ({ page }) => {
  await showGroup(page)
  await expectAligned(page, 'notes:mcp')
  await page.evaluate(() => window.dispatchEvent(new Event('scroll')))
  await expect
    .poll(() =>
      page.evaluate(() => {
        window.dispatchEvent(new Event('scroll'))
        return Object.values(localStorage).some((value) =>
          value.includes('"rowKey":"notes:mcp"'),
        )
      }),
    )
    .toBe(true)
  await page.reload()
  await expect(group(page)).toBeVisible()
  await expectAligned(page, 'notes:mcp')
  await expect(group(page)).toHaveAttribute('aria-expanded', 'false')
  await expect(note(page, 'mcp')).toHaveCount(0)
})

test('loads an anchored window for a collapsed note and wraps content on narrow screens', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/?fixture=notes&id=notes&unloaded&readOnly')
  await page.getByRole('button', { name: 'Seek workspace' }).click()
  await expect(note(page, 'workspace').locator('strong')).toHaveText(
    'Workspace details',
  )
  await expectAligned(page, 'hid:workspace')
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390)
  await note(page, 'workspace').click({ button: 'right' })
  await expect(page.getByRole('menu')).toHaveCount(0)
})

test('shows command details and retains copy and confirmed deletion actions', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: async (text: string) => {
          localStorage.setItem('copied-note', text)
        },
      },
    })
  })
  await page.reload()
  await showGroup(page)
  await group(page).press('Enter')
  await waitForGroupAnimation(page)
  await note(page, 'command').getByRole('button').press('Enter')
  await expect(note(page, 'command')).toContainText('Status: failed')
  await expect(note(page, 'command')).toContainText('Command failed')
  await note(page, 'command').evaluate(async (element) => {
    await Promise.all(
      element
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished.catch(() => {})),
    )
  })
  await note(page, 'command').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Copy Content' }).click()
  expect(await page.evaluate(() => localStorage.getItem('copied-note'))).toBe(
    '/timeout 30',
  )
  await expect(page.getByRole('menu')).toHaveCount(0)
  await note(page, 'command').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
  await expect(note(page, 'command')).toBeVisible()
  await note(page, 'command').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click()
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: 'Delete', exact: true })
    .click()
  await expect(note(page, 'command')).toHaveCount(0)
  await expect(group(page)).toHaveAccessibleName('Collapse 3 notes')
})

test('Delete all removes later messages and leaves the earlier note as a singleton', async ({
  page,
}) => {
  await showGroup(page)
  await group(page).press('Enter')
  await waitForGroupAnimation(page)
  await note(page, 'workspace').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click()
  await page.getByRole('button', { name: 'Delete all', exact: true }).click()
  await expect(group(page)).toHaveCount(0)
  await expect(note(page, 'mcp')).toBeVisible()
  await expect(note(page, 'workspace')).toHaveCount(0)
  await note(page, 'mcp').getByRole('button').click()
  await expect(note(page, 'mcp')).toContainText('Content for mcp')
})

test('/new inserts a deletable context marker without an active agent', async ({
  page,
}) => {
  await page.goto('/?fixture=notes&id=notes&contextReset')
  const editor = page.locator('[data-slot="chat-box"] [contenteditable="true"]')
  await editor.fill('/new')
  await expect(page.getByRole('option', { name: /\/new/ })).toBeVisible()
  await editor.press('Enter')

  const markers = page.locator('[data-slot="context-reset"]')
  const marker = markers.first()
  await expect(marker.getByText('Context reset', { exact: true })).toBeVisible()
  await expect(marker.getByRole('button')).toHaveCount(0)
  await editor.fill('Message after reset')
  await editor.press('Enter')
  const body = page.getByText('Message after reset', { exact: true })
  await expect(body).toBeVisible()

  await editor.fill('/new')
  await editor.press('Enter')
  await expect(markers).toHaveCount(2)
  await marker.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click()
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: 'Delete', exact: true })
    .click()
  await expect(markers).toHaveCount(1)
  await expect(
    page.getByText('Content for before-reset', { exact: true }),
  ).toBeVisible()
  await expect(
    page.getByText('Message after reset', { exact: true }),
  ).toBeVisible()
})

test('defers the live work duration while an empty continuation is active', async ({
  page,
}) => {
  await page.goto('/?fixture=notes&id=notes&composer&continuation')
  const activity = page.getByRole('status', { name: 'Agent is working' })
  const earlierDuration = page.getByText('Worked for 8.3s', { exact: true })
  const liveDuration = page.getByText('Worked for 4.2s', { exact: true })

  await expect(activity).toBeVisible()
  await expect(earlierDuration).toBeVisible()
  await expect(liveDuration).toHaveCount(0)

  await page
    .locator('[data-slot="chat-box"]')
    .getByRole('button', { name: 'Stop', exact: true })
    .click()
  await expect(liveDuration).toBeVisible()
  await expect(activity).toHaveCount(0)
})
