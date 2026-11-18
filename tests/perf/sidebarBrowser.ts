import { APP_ID } from '@cv/core/const'
import { type Locator, type Page, chromium, expect } from '@playwright/test'

import type { SessionId } from './clients'
import { timings } from './report'
import type { Scenario } from './sidebar'

const indicator = '[aria-label="Streaming"], [aria-label="Unread, streaming"]'

type BrowserScenario = Scenario & {
  record: (run: Record<string, unknown>) => void
  extraIds: SessionId[]
  frontend: string
  backgroundViewers: number
}

export async function browserScenario(scenario: BrowserScenario) {
  const browser = await chromium.launch()
  try {
    const context = await browser.newContext({
      storageState: scenario.accounts[0].state,
      reducedMotion: 'reduce',
      viewport: { width: 1440, height: 900 },
    })
    const page = await context.newPage()
    const subscribed = trackSidebarQueries(page)
    await context.addInitScript((storageKey) => {
      localStorage.setItem(
        storageKey,
        JSON.stringify({
          sidebar: { left: { collapsed: false, pinned: true } },
        }),
      )
    }, `${APP_ID}-ui-settings`)
    page.setDefaultTimeout(10_000)
    await page.goto(scenario.frontend)
    const left = page.locator('[data-slot="sidebar-panel"][data-side="left"]')
    const recents = page.locator('[data-session-page="recents"]')
    const row = recents.getByRole('button', { name: /Perf chat 000/ })
    await expect(row).toBeVisible({ timeout: 20_000 })
    await expect.poll(() => subscribed().length).toBe(10)
    await measureIndicator(row, scenario)
    await checkNavigation(page, recents, subscribed, scenario)
    await left
      .locator(
        '[data-slot="sidebar-expanded"] [data-slot="sidebar-toggle"] button',
      )
      .last()
      .click()
    await expect.poll(subscribed).toEqual([])
    scenario.record({
      scenario: 'navigation',
      crossedBatchBoundary: true,
      duplicateDisplay: true,
      search: true,
    })
  } finally {
    await browser.close()
  }
}

async function measureIndicator(row: Locator, scenario: BrowserScenario) {
  const badge = row.locator(indicator)
  const samples = []
  let measuredAt = 0
  for (let index = -2; index < 10; index++) {
    const begin = performance.now()
    if (index === 0) measuredAt = begin
    const shown = badge
      .waitFor({ state: 'visible', timeout: 10_000 })
      .then(() => performance.now() - begin)
    const [streams, shownMs] = await Promise.all([
      scenario.start([scenario.sessions[0]]),
      shown,
    ])
    if (index >= 0) samples.push(shownMs)
    const stop = performance.now()
    const hidden = badge
      .waitFor({ state: 'hidden', timeout: 10_000 })
      .then(() => performance.now() - stop)
    const [, hiddenMs] = await Promise.all([scenario.stop(streams), hidden])
    if (index >= 0) samples.push(hiddenMs)
  }
  scenario.record({
    scenario: 'chromium',
    visibleRecents: 10,
    backgroundViewers: scenario.backgroundViewers,
    rendered: timings(samples, performance.now() - measuredAt, 4),
  })
}

async function checkNavigation(
  page: Page,
  recents: Locator,
  subscribed: () => SessionId[],
  scenario: BrowserScenario,
) {
  const more = recents.getByRole('button', { name: 'Show more' })
  await more.click()
  await expect.poll(() => subscribed().length).toBe(30)
  await more.click()
  const farId = scenario.extraIds.at(-1)!
  const farRow = recents.getByRole('button', { name: /Perf chat 166/ })
  const farStream = await scenario.start([farId])
  await expect(farRow.locator(indicator)).toBeVisible()
  await expect.poll(() => subscribed().length).toBe(40)
  await recents.getByRole('button', { name: 'Show less' }).click()
  await expect(farRow).toHaveCount(0)
  await expect.poll(() => subscribed().includes(farId)).toBe(false)

  await checkFolder(page, recents, subscribed, scenario)
  await page.getByRole('textbox', { name: 'Search sessions' }).fill('166')
  const search = page.locator('[data-session-page="search"]')
  const searched = search.getByRole('button', { name: /Perf chat 166/ })
  await expect(searched.locator(indicator)).toBeVisible()
  await expect.poll(subscribed).toEqual([farId])
  await scenario.stop(farStream)
  await expect(searched.locator(indicator)).toHaveCount(0)
}

async function checkFolder(
  page: Page,
  recents: Locator,
  subscribed: () => SessionId[],
  scenario: BrowserScenario,
) {
  const folder = page.getByRole('button', { name: 'Perf folder', exact: true })
  await folder.click()
  const folderRow = page
    .locator('[data-session-folder]')
    .getByRole('button', { name: /Perf chat 128/ })
  await expect(folderRow).toBeVisible()
  const sharedDisplay = await scenario.start([scenario.extraIds[0]])
  await expect(folderRow.locator(indicator)).toBeVisible()
  await expect(
    recents.getByRole('button', { name: /Perf chat 128/ }).locator(indicator),
  ).toBeVisible()
  await expect
    .poll(() => subscribed().filter((id) => id === scenario.extraIds[0]).length)
    .toBe(1)
  await recents.getByRole('button', { name: 'Show less' }).click()
  const folderPage = page.locator('[data-session-folder] [data-session-page]')
  await folderPage.getByRole('button', { name: 'Show more' }).click()
  await expect.poll(() => subscribed().length).toBe(26)
  await folder.click()
  await expect(folderRow).toHaveCount(0)
  await expect.poll(() => subscribed().length).toBe(10)
  await scenario.stop(sharedDisplay)
}

type Modification =
  | {
      type: 'Add'
      queryId: number
      udfPath: string
      args: [{ sessionIds: SessionId[] }]
    }
  | { type: 'Remove'; queryId: number }

/** Reads query subscriptions from the app's Convex WebSocket. */
function trackSidebarQueries(page: Page) {
  const active = new Map<number, SessionId[]>()
  page.on('websocket', (socket) => {
    socket.on('framesent', ({ payload }) => {
      const message = JSON.parse(payload.toString()) as {
        type: string
        modifications: Modification[]
      }
      if (message.type !== 'ModifyQuerySet') return
      for (const modification of message.modifications) {
        if (modification.type === 'Remove') active.delete(modification.queryId)
        else if (
          modification.udfPath === 'streams:activeSessionIdsForSessions'
        ) {
          active.set(modification.queryId, modification.args[0].sessionIds)
        }
      }
    })
    socket.on('close', () => active.clear())
  })
  return () => [...active.values()].flat()
}
