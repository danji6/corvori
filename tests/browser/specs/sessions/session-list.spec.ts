import { type Page, expect, test } from '@playwright/test'
import {
  dragTo,
  folder,
  loadedPages,
  openSessionFolders,
  pageControl,
  sessionPage,
} from '~/tests/browser/session-folders-helpers'

test.beforeEach(async ({ page }) => openSessionFolders(page))

async function samplePageExpansion(page: Page, groupKey: string) {
  const content = page.locator(`[data-session-page="${groupKey}"]`)
  const more = pageControl(page, groupKey)
  await more.scrollIntoViewIfNeeded()
  await more.focus()
  return content.evaluate(async (element) => {
    await new Promise(requestAnimationFrame)
    const scrollArea = element.closest(
      '[data-slot="session-list-scroll-area"]',
    )!
    const firstRow = element.querySelector('button')!
    const initialTop = firstRow.getBoundingClientRect().top
    const button = element.querySelector<HTMLButtonElement>(
      `[data-page-footer="${element.getAttribute('data-session-page')}"] [data-pagination="more"]`,
    )!
    const surface =
      element
        .closest('[data-session-folder]')
        ?.querySelector<HTMLElement>(
          ':scope > [data-slot="collapsible-content"]',
        ) ?? element
    const read = () => ({
      height: surface.getBoundingClientRect().height,
      scrollTop: scrollArea.scrollTop,
      firstTop: firstRow.getBoundingClientRect().top,
      sameRow: element.querySelector('button') === firstRow,
      animations: surface.getAnimations().length,
    })
    const samples = [read()]
    button.click()
    const start = performance.now()
    while (performance.now() - start < 450) {
      await new Promise(requestAnimationFrame)
      samples.push(read())
    }
    return {
      samples,
      initialTop,
    }
  })
}

test('Show more reveals top-level folders, folder contents, Recents, and search without moving existing rows', async ({
  page,
}) => {
  await page.goto('/?fixture=session-folders&manySessions')
  for (const groupKey of ['a', 'recents', 'search', 'folders']) {
    if (groupKey === 'search') {
      await page
        .getByRole('textbox', { name: 'Search sessions' })
        .fill('session')
      await expect.poll(async () => (await loadedPages(page)).search).toBe(20)
    }
    if (groupKey === 'folders') {
      await page.goto('/?fixture=session-folders&manyFolders')
    }
    const entries = sessionPage(page, groupKey).locator(
      `[data-page-entry="${groupKey}"]`,
    )
    const before = await entries.count()
    const { samples, initialTop } = await samplePageExpansion(page, groupKey)
    await expect.poll(() => entries.count()).toBeGreaterThan(before)
    const initial = samples[0]!
    expect(samples.every(({ sameRow }) => sameRow)).toBe(true)
    expect(
      samples.every(({ firstTop }) => Math.abs(firstTop - initialTop) < 1),
    ).toBe(true)
    expect(
      samples.every(
        ({ scrollTop }) => Math.abs(scrollTop - initial.scrollTop) < 1,
      ),
    ).toBe(true)
  }
})

test('reduced motion skips the page reveal and collapsing cancels it before unloading', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/?fixture=session-folders&manySessions')
  const { samples } = await samplePageExpansion(page, 'a')
  expect(samples.at(-1)!.height).toBeGreaterThan(samples[0]!.height)
  expect(samples.every(({ animations }) => animations === 0)).toBe(true)

  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.reload()
  const content = page.locator('[data-session-page="a"]')
  const canceled = await content.evaluate(async (element) => {
    const surface = element
      .closest('[data-session-folder]')!
      .querySelector<HTMLElement>(':scope > [data-slot="collapsible-content"]')!
    element
      .querySelector<HTMLButtonElement>(
        `[data-page-footer="${element.getAttribute('data-session-page')}"] button`,
      )!
      .click()
    const start = performance.now()
    while (
      !surface.getAnimations().length &&
      performance.now() - start < 1000
    ) {
      await new Promise(requestAnimationFrame)
    }
    const started = surface.getAnimations().length === 1
    const reveal = surface.getAnimations()[0]!
    element
      .closest('[data-session-folder="a"]')!
      .querySelector<HTMLButtonElement>('button[aria-expanded]')!
      .click()
    await new Promise(requestAnimationFrame)
    return {
      started,
      canceled: reveal.playState === 'idle',
    }
  })
  expect(canceled).toEqual({ started: true, canceled: true })
  await expect.poll(async () => (await loadedPages(page)).a).toBeUndefined()
  await folder(page, 'Portfolio').click()
  await expect.poll(async () => (await loadedPages(page)).a).toBe(4)
})

test('sidebar edges and empty space do not highlight or move sessions', async ({
  page,
}) => {
  await folder(page, 'Recents').click()
  await expect(sessionPage(page, 'recents')).toHaveCount(0)
  const source = sessionPage(page, 'b').getByRole('button', {
    name: 'Corvori chat',
    exact: false,
  })
  const sidebar = page.getByTestId('sidebar')
  const highlights = sidebar.locator('[class~="bg-primary/15"]')
  await dragTo(page, source, folder(page, 'Recents'))
  await expect(highlights).toHaveCount(1)
  const bounds = (await sidebar.boundingBox())!
  const row = (await source.boundingBox())!
  for (const x of [bounds.x + 2, bounds.x + bounds.width - 2]) {
    await page.mouse.move(x, row.y + row.height / 2, { steps: 5 })
    await expect(highlights).toHaveCount(0)
  }
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height - 5) // prettier-ignore
  await expect(highlights).toHaveCount(0)
  await page.mouse.up()
  await expect(
    page.locator('[data-session-page="b"]').getByRole('button', {
      name: 'Corvori chat',
      exact: false,
    }),
  ).toBeVisible()
})

test('starting a drag finishes a page reveal before choosing a drop target', async ({
  page,
}) => {
  await page.goto('/?fixture=session-folders&manySessions')
  const content = page.locator('[data-session-page="a"]')
  const source = content.getByRole('button', {
    name: 'Portfolio chat',
    exact: false,
  })
  await source.scrollIntoViewIfNeeded()
  await source.focus()
  const started = await content.evaluate(async (element) => {
    const surface = element
      .closest('[data-session-folder]')!
      .querySelector<HTMLElement>(':scope > [data-slot="collapsible-content"]')!
    element
      .querySelector<HTMLButtonElement>(
        `[data-page-footer="${element.getAttribute('data-session-page')}"] button`,
      )!
      .click()
    const start = performance.now()
    while (
      !surface.getAnimations().length &&
      performance.now() - start < 1000
    ) {
      await new Promise(requestAnimationFrame)
    }
    return surface.getAnimations().length === 1
  })
  expect(started).toBe(true)
  await page.keyboard.press('Space')
  await expect(content).toHaveCSS(
    'height',
    await content.evaluate((element) => `${element.scrollHeight}px`),
  )
  expect(
    await content.evaluate(
      (element) =>
        element
          .closest('[data-session-folder]')!
          .querySelector(':scope > [data-slot="collapsible-content"]')!
          .getAnimations().length,
    ),
  ).toBe(0)
  await page.keyboard.press('Escape')
  await expect(source).toBeFocused()
  await expect.poll(async () => (await loadedPages(page)).a).toBe(24)
})

test('dragging a Recents row onto another Recents row leaves its folder alone', async ({
  page,
}) => {
  const recents = sessionPage(page, 'recents')
  const source = recents.getByRole('button', {
    name: 'Corvori chat',
    exact: false,
  })
  const destination = recents.getByRole('button', {
    name: 'Portfolio chat',
    exact: false,
  })
  await dragTo(page, source, destination)
  await expect(
    page.getByTestId('sidebar').locator('[class~="bg-primary/15"]'),
  ).toHaveCount(0)
  await page.mouse.up()
  await expect(source).toBeVisible()
  await expect(sessionPage(page, 'b').getByText('Corvori chat')).toBeVisible()
})

test('a stationary drag scrolls through the bottom edge band and back up', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/?fixture=session-folders&manySessions')
  await page.getByRole('textbox', { name: 'Search sessions' }).fill('session')
  await expect.poll(async () => (await loadedPages(page)).search).toBe(20)
  const scroller = page.locator('[data-slot="session-list-scroll-area"]')
  const top = () => scroller.evaluate((element) => element.scrollTop)
  const source = sessionPage(page, 'search').getByRole('button').nth(3)
  const bounds = (await scroller.boundingBox())!
  const row = (await source.boundingBox())!
  const x = row.x + row.width / 2
  const y = row.y + row.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + 12, y - 10)
  await page.mouse.move(x, bounds.y + bounds.height * 0.78)
  await expect.poll(top).toBeGreaterThan(15)
  const before = await top()
  await page.mouse.move(x, bounds.y + bounds.height - 8)
  await expect.poll(top).toBeGreaterThan(before + 50)
  const down = await top()
  await page.mouse.move(x, bounds.y + 8)
  await expect.poll(top).toBeLessThan(down - 30)
  await page.keyboard.press('Escape')
})

test('closing unloads the branch after animating and reopening resets pagination', async ({
  page,
}) => {
  await page.goto('/?fixture=session-folders&manySessions')
  const branch = page.locator('[data-session-folder="a"]')
  const loadMore = branch.getByRole('button', { name: 'Show more' }).last()
  await expect.poll(async () => (await loadedPages(page)).a).toBe(4)
  await loadMore.click()
  await expect.poll(async () => (await loadedPages(page)).a).toBe(24)
  // All loaded rows remain mounted even when below the scroll viewport.
  await expect(branch.getByText(/^a session /)).toHaveCount(23)
  await folder(page, 'Portfolio').click()
  const content = branch.locator(':scope > [data-slot="collapsible-content"]')
  await expect(content).toHaveAttribute('inert', '')
  await expect.poll(async () => (await loadedPages(page)).a).toBeUndefined()
  await expect.poll(async () => (await loadedPages(page)).n).toBeUndefined()
  await expect(branch.getByText(/^a session /)).toHaveCount(0)
  await folder(page, 'Portfolio').click()
  await expect.poll(async () => (await loadedPages(page)).a).toBe(4)
  await expect.poll(async () => (await loadedPages(page)).n).toBe(5)
  await expect(branch.getByText(/^a session /)).toHaveCount(3)
})

test('Recents start at ten and folder loading feedback stays local', async ({
  page,
}) => {
  await page.goto('/?fixture=session-folders&manySessions&slowSessions')
  const sidebar = page.getByTestId('sidebar')
  const resolve = page.getByRole('button', { name: 'Resolve session queries' })
  await expect.poll(async () => (await loadedPages(page)).recents).toBe(0)
  await expect(
    page.locator('[data-session-page="recents"] > [role="status"]'),
  ).toHaveCount(0)
  await resolve.click()
  await expect
    .poll(() => loadedPages(page))
    .toEqual({ pinned: 5, a: 4, n: 5, b: 5, recents: 10 })

  const loadMore = sessionPage(page, 'recents').getByRole('button', {
    name: 'Show more',
  })
  await loadMore.click()
  await expect(loadMore).toBeDisabled()
  await expect(
    page.locator('[data-session-page="recents"] > [role="status"]'),
  ).toHaveCount(0)
  await expect(sidebar.getByText('No matching sessions')).toHaveCount(0)
  await resolve.click()
  await expect.poll(async () => (await loadedPages(page)).recents).toBe(30)
  await expect(loadMore).toBeEnabled()

  const search = page.getByRole('textbox', { name: 'Search sessions' })
  await search.fill('session')
  await expect.poll(async () => (await loadedPages(page)).search).toBe(0)
  await resolve.click()
  await expect.poll(async () => (await loadedPages(page)).search).toBe(20)
  await search.fill('no matching session')
  await expect.poll(async () => (await loadedPages(page)).search).toBe(0)
  await resolve.click()
  await expect(sidebar.getByText('No matching sessions')).toBeVisible()
})

test('reversing a collapse keeps content and pagination until a completed collapse', async ({
  page,
}) => {
  await page.goto('/?fixture=session-folders&manySessions')
  const branch = page.locator('[data-session-folder="a"]')
  await branch.getByRole('button', { name: 'Show more' }).last().click()
  await expect.poll(async () => (await loadedPages(page)).a).toBe(24)
  await folder(page, 'Portfolio').evaluate((button) =>
    (button as HTMLButtonElement).click(),
  )
  await folder(page, 'Portfolio').evaluate((button) =>
    (button as HTMLButtonElement).click(),
  )
  await expect(folder(page, 'Portfolio')).toHaveAttribute(
    'aria-expanded',
    'true',
  )
  await expect.poll(async () => (await loadedPages(page)).a).toBe(24)
})

test('reduced motion and subtree collapse unload descendants but leave Recents', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/?fixture=session-folders&manySessions')
  await expect
    .poll(async () => Object.keys(await loadedPages(page)).length)
    .toBe(5)
  const collapse = page.getByRole('button', {
    name: 'Collapse Portfolio and subfolders',
    exact: true,
  })
  await expect(collapse).toBeVisible()
  await collapse.click()
  await expect(collapse).toHaveCount(0)
  await expect(folder(page, 'Portfolio')).toBeFocused()
  await expect.poll(async () => (await loadedPages(page)).a).toBeUndefined()
  await expect.poll(async () => (await loadedPages(page)).n).toBeUndefined()
  await expect.poll(async () => (await loadedPages(page)).recents).toBe(10)
  await folder(page, 'Portfolio').click()
  await expect.poll(async () => (await loadedPages(page)).a).toBe(4)
  await expect(folder(page, 'Design')).toHaveAttribute('aria-expanded', 'false')
  await expect.poll(async () => (await loadedPages(page)).n).toBeUndefined()
})

test('a few hundred loaded sessions collapse and reset when reopened individually', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/?fixture=session-folders&manySessions')
  await expect
    .poll(async () => Object.keys(await loadedPages(page)).length)
    .toBe(5)
  for (const id of ['n', 'a', 'b', 'pinned']) {
    const button = pageControl(page, id)
    for (let count = 0; count < 3; count++) {
      if (await button.count()) {
        await button.click()
        const expected = Math.min(
          (id === 'a' ? 4 : 5) + (count + 1) * 20,
          id === 'pinned' ? 30 : 126,
        )
        await expect
          .poll(async () => (await loadedPages(page))[id])
          .toBe(expected)
      }
    }
  }
  const recentsMore = sessionPage(page, 'recents').getByRole('button', {
    name: 'Show more',
  })
  for (let count = 1; count <= 3; count++) {
    await recentsMore.click()
    await expect
      .poll(async () => (await loadedPages(page)).recents)
      .toBe(10 + count * 20)
  }
  await expect
    .poll(async () =>
      Object.values(await loadedPages(page)).reduce(
        (sum, count) => sum + count,
        0,
      ),
    )
    .toBe(294)
  const collapse = page.getByRole('button', { name: 'Collapse all folders' })
  await expect(collapse).toBeEnabled()
  await collapse.click()
  await expect(collapse).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: 'Session list options' }),
  ).toBeFocused()
  await expect.poll(() => loadedPages(page)).toEqual({ recents: 70 })

  await folder(page, 'Pinned').click()
  await expect(collapse).toBeEnabled()
  await folder(page, 'Pinned').click()
  await expect(collapse).toHaveCount(0)
  await folder(page, 'Portfolio').click()
  await expect(collapse).toBeEnabled()
  await expect(folder(page, 'Design')).toHaveAttribute('aria-expanded', 'false')
  for (const name of ['Design', 'Pinned', 'Corvori']) {
    await folder(page, name).click()
  }
  await expect
    .poll(() => loadedPages(page))
    .toEqual({ recents: 70, pinned: 5, a: 4, n: 5, b: 5 })
})
