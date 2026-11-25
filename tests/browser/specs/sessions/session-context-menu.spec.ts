import { type Page, expect, test } from '@playwright/test'
import {
  seedExpandedFolders,
  sessionPage,
} from '~/tests/browser/session-folders-helpers'

test.beforeEach(async ({ page }) => seedExpandedFolders(page))

const longTitle =
  'Portfolio chat with a title that scrolls across the session row '
    .repeat(4)
    .trim()

function sessionRow(page: Page, title = longTitle, group = 'a') {
  return sessionPage(page, group)
    .getByRole('button')
    .filter({
      has: page.getByText(title, { exact: true }),
    })
}

function sessionTooltip(page: Page, title: string) {
  return page
    .locator('[data-slot="tooltip-content"]')
    .filter({ hasText: title })
}

test('keeps a session row hovered while its tooltip opens', async ({
  page,
}) => {
  await page.goto('/?fixture=session-folders')
  const row = sessionRow(page, 'Portfolio chat', 'recents')
  await row.evaluate((element) => {
    element.addEventListener(
      'pointerleave',
      () => element.setAttribute('data-pointer-left', ''),
      { once: true },
    )
  })
  const bounds = (await row.boundingBox())!
  // The tooltip arrow used to cross the top edge during its entrance.
  await row.hover({ position: { x: bounds.width / 2, y: 0.5 } })

  const tooltip = sessionTooltip(page, 'Portfolio chat')
  await expect(tooltip).toHaveCSS('opacity', '1')
  await expect(row).not.toHaveAttribute('data-pointer-left', '')
})

test('a session title tooltip lets the pointer reach the neighboring row', async ({
  page,
}) => {
  await page.goto('/?fixture=session-folders')
  const upperRow = sessionRow(page, 'Portfolio chat', 'recents')
  const lowerRow = sessionRow(page, 'Design chat', 'recents')
  await lowerRow.hover()
  const tooltip = sessionTooltip(page, 'Design chat')
  await expect(tooltip).toHaveCSS('opacity', '1')

  // This tooltip sits over part of the row immediately above its trigger.
  const bounds = (await tooltip.boundingBox())!
  const x = bounds.x + bounds.width / 2
  const y = bounds.y + bounds.height / 2
  await page.mouse.move(x, y)
  await expect
    .poll(() => upperRow.evaluate((element) => element.matches(':hover')))
    .toBe(true)
})

test('keeps the menu open during title animation and its reset, then selects an action', async ({
  page,
}) => {
  await page.goto('/?fixture=session-folders&longTitle')
  const row = sessionRow(page)
  const title = row.getByText(longTitle, { exact: true })
  await row.hover()
  await expect
    .poll(() => title.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(0)
  await row.click({ button: 'right' })
  await expect(page.getByRole('menu')).toBeVisible()
  const initialScroll = await title.evaluate((element) => element.scrollLeft)
  await expect
    .poll(() => title.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(initialScroll + 10)
  await expect(page.getByRole('menu')).toBeVisible()

  const pin = page.getByRole('menuitem', { name: 'Pin', exact: true })
  await pin.hover()
  await expect
    .poll(() => title.evaluate((element) => element.scrollLeft))
    .toBe(0)
  await expect(page.getByRole('menu')).toBeVisible()
  await pin.click()
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(
    page
      .locator('[data-session-folder="pinned"]')
      .getByText(longTitle, { exact: true }),
  ).toBeVisible()
})

test('dismisses when the session list or the page scrolls', async ({
  page,
}) => {
  await page.goto('/?fixture=session-folders&manySessions')
  // Keep the trigger visible so Playwright's initial auto-scroll cannot dismiss it.
  const row = sessionRow(page, 'Pinned session 2', 'pinned')
  await row.click({ button: 'right' })
  await expect(page.getByRole('menu')).toBeVisible()
  await row.evaluate((element) => {
    element.closest('[data-slot="session-list-scroll-area"]')!.scrollTop += 30
  })
  await expect(page.getByRole('menu')).toHaveCount(0)

  await row.click({ button: 'right' })
  await expect(page.getByRole('menu')).toBeVisible()
  await page.evaluate(() => {
    document.body.style.paddingBottom = '1000px'
    window.scrollTo(0, 50)
  })
  await expect(page.getByRole('menu')).toHaveCount(0)
})

test('retains normal dismissal for short titles', async ({ page }) => {
  await page.goto('/?fixture=session-folders')
  const row = sessionRow(page, 'Portfolio chat')
  await row.click({ button: 'right' })
  await expect(page.getByRole('menu')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await row.click({ button: 'right' })
  await expect(page.getByRole('menu')).toBeVisible()
  await page.getByRole('checkbox', { name: 'Disable picker' }).click()
  await expect(page.getByRole('menu')).toHaveCount(0)
  await row.click({ button: 'right' })
  await expect(page.getByRole('menu')).toBeVisible()
  await page.setViewportSize({ width: 1000, height: 700 })
  await expect(page.getByRole('menu')).toHaveCount(0)
})

test('supports reduced motion without scrolling the title', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/?fixture=session-folders&longTitle')
  const row = sessionRow(page)
  await row.hover()
  await row.click({ button: 'right' })
  await expect(page.getByRole('menu')).toBeVisible()
  expect(
    await row
      .getByText(longTitle, { exact: true })
      .evaluate((element) => element.scrollLeft),
  ).toBe(0)
  await page.getByRole('menuitem', { name: 'Rename…', exact: true }).click()
  await expect(page.getByRole('menu')).toHaveCount(0)
})

test('allows scrolling the menu and reopens at the latest right-click', async ({
  page,
}) => {
  await page.goto('/?fixture=session-folders')
  const row = sessionRow(page, 'Portfolio chat')
  await row.click({ button: 'right' })
  const menu = page.getByRole('menu')
  await expect(menu).toBeVisible()
  await menu.evaluate((element) => {
    element.style.height = '80px'
    element.style.overflowY = 'auto'
    element.scrollTop = 30
  })
  await expect
    .poll(() => menu.evaluate((element) => element.scrollTop))
    .toBe(30)
  await expect(menu).toBeVisible()
  const bounds = (await row.boundingBox())!
  const x = Math.round(bounds.x + bounds.width / 2) - 10
  const y = Math.round(bounds.y + bounds.height / 2)
  await page.mouse.click(x, y, { button: 'right' })
  await expect(menu).toHaveCSS('left', `${x}px`)
  await expect(
    menu.getByRole('menuitem', { name: 'Rename…', exact: true }),
  ).toBeVisible()
})
