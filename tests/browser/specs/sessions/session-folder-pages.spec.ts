import { expect, test } from '@playwright/test'
import {
  folder,
  loadedPages,
  pageControl,
  seedExpandedFolders,
  sessionPage,
} from '~/tests/browser/session-folders-helpers'

test('root folders and Recents paginate independently while subfolders share their five-item budget', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/?fixture=session-folders&manyFolders&manySessions')
  const counts = async () =>
    JSON.parse((await page.getByTestId('loaded-folders').textContent()) ?? '{}')
  await expect.poll(async () => (await counts()).folders).toBe(5)
  await expect.poll(async () => (await loadedPages(page)).recents).toBe(10)
  await folder(page, 'Portfolio').click()
  await expect.poll(async () => (await counts()).a).toBe(5)
  await expect.poll(async () => (await loadedPages(page)).a).toBe(0)
  await expect(folder(page, 'Root folder 30')).toHaveCount(0)
  expect((await loadedPages(page))['root-folder-29']).toBeUndefined()

  const childMore = pageControl(page, 'a')
  await childMore.click()
  await expect.poll(async () => (await counts()).a).toBe(25)
  await expect.poll(async () => (await loadedPages(page)).a).toBe(0)
  await childMore.click()
  await expect.poll(async () => (await counts()).a).toBe(31)
  await expect.poll(async () => (await loadedPages(page)).a).toBe(14)
  await pageControl(page, 'a', 'Show less').click()
  await expect.poll(async () => (await counts()).a).toBe(25)
  await expect.poll(async () => (await loadedPages(page)).a).toBe(0)

  const rootMore = pageControl(page, 'folders')
  const recentsMore = pageControl(page, 'recents')
  await rootMore.click()
  await expect.poll(async () => (await counts()).folders).toBe(25)
  await expect.poll(async () => (await loadedPages(page)).recents).toBe(10)
  const moreBounds = (await rootMore.boundingBox())!
  const lessBounds = (await pageControl(
    page,
    'folders',
    'Show less',
  ).boundingBox())!
  expect(lessBounds.x).toBeGreaterThan(moreBounds.x + moreBounds.width)
  expect(moreBounds.y).toBe(lessBounds.y)
  await recentsMore.click()
  await expect.poll(async () => (await loadedPages(page)).recents).toBe(30)
  await expect.poll(async () => (await counts()).folders).toBe(25)
  await expect(rootMore).toBeEnabled()
  await rootMore.click()
  await expect.poll(async () => (await counts()).folders).toBe(32)
  await expect(rootMore).toHaveCount(0)
  await expect(recentsMore).toBeEnabled()
  await pageControl(page, 'folders', 'Show less').click()
  await expect.poll(async () => (await counts()).folders).toBe(25)
  await expect.poll(async () => (await loadedPages(page)).recents).toBe(30)
  await pageControl(page, 'recents', 'Show less').click()
  await expect.poll(async () => (await loadedPages(page)).recents).toBe(10)
  await expect.poll(async () => (await counts()).folders).toBe(25)
  await expect(pageControl(page, 'recents', 'Show less')).toHaveCount(0)
  await rootMore.click()
  await expect.poll(async () => (await counts()).folders).toBe(32)
})

test('Recents starts open and reacts to activity from an unloaded folder', async ({
  page,
}) => {
  await page.goto('/?fixture=session-folders&manyFolders&manySessions')
  const trigger = folder(page, 'Recents')
  const recents = sessionPage(page, 'recents')
  await expect(trigger).toHaveAttribute('aria-expanded', 'true')
  await expect(folder(page, 'Pinned')).toHaveAttribute('aria-expanded', 'false')
  await expect(folder(page, 'Root folder 30')).toHaveCount(0)
  await expect(recents.getByText('Chat in unloaded folder')).toHaveCount(0)
  await page
    .getByRole('button', { name: 'Update folder chat activity' })
    .click()
  await expect(recents.getByRole('button').first()).toContainText(
    'Chat in unloaded folder',
  )
  await expect(folder(page, 'Root folder 30')).toHaveCount(0)
  await recents.getByRole('button', { name: 'Show more', exact: true }).click()
  await expect.poll(async () => (await loadedPages(page)).recents).toBe(30)
  await trigger.press('Space')
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')
  await expect(recents.getByRole('button')).toHaveCount(0)
  await trigger.press('Enter')
  await expect(trigger).toHaveAttribute('aria-expanded', 'true')
  await expect(recents.getByRole('button').first()).toContainText(
    'Chat in unloaded folder',
  )
  await expect.poll(async () => (await loadedPages(page)).recents).toBe(30)
})

test('Pinned paginates folders before sessions and supports unloaded real ancestors', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await seedExpandedFolders(page)
  await page.goto('/?fixture=session-folders&manySessions&manyPinnedFolders')
  const counts = async () =>
    JSON.parse((await page.getByTestId('loaded-folders').textContent()) ?? '{}')
  await expect.poll(async () => (await counts()).pinned).toBe(5)
  await expect.poll(async () => (await loadedPages(page)).pinned).toBe(0)
  await expect(folder(page, 'Pinned folder 6')).toHaveCount(0)
  await folder(page, 'Portfolio').click()
  await expect.poll(async () => (await loadedPages(page)).a).toBeUndefined()
  await pageControl(page, 'pinned').click()
  await expect.poll(async () => (await counts()).pinned).toBe(12)
  await expect.poll(async () => (await loadedPages(page)).pinned).toBe(13)
  await expect(folder(page, 'Pinned folder 12')).toHaveCount(1)
  await pageControl(page, 'pinned', 'Show less').click()
  await expect.poll(async () => (await counts()).pinned).toBe(5)
  await expect.poll(async () => (await loadedPages(page)).pinned).toBe(0)
})

test('picker searches unloaded folders and inherited collapse choices do not fetch hidden branches', async ({
  page,
}) => {
  await page.goto('/?fixture=session-folders&manyFolders')
  await folder(page, 'Portfolio').click()
  await expect(folder(page, 'Portfolio')).toHaveAttribute(
    'aria-expanded',
    'true',
  )
  await page.getByRole('button', { name: 'Collapse all folders' }).click()
  await page
    .getByTestId('sidebar')
    .getByRole('button', { name: 'Show more' })
    .click()
  await expect(folder(page, 'Root folder 20')).toHaveAttribute(
    'aria-expanded',
    'false',
  )
  expect((await loadedPages(page))['root-folder-19']).toBeUndefined()
  const picker = page.getByRole('combobox', {
    name: 'Session folder',
    exact: true,
  })
  await picker.click()
  await page.getByPlaceholder('Search folders…').fill('Root folder 30')
  await page
    .getByRole('option', { name: 'Root folder 30', exact: true })
    .click()
  await expect(picker).toHaveText('Root folder 30')
  await expect(folder(page, 'Root folder 30')).toHaveCount(0)
})

test('a delayed first page loads without a loading label', async ({ page }) => {
  await page.goto('/?fixture=session-folders&manySessions&slowSessions')
  await expect(folder(page, 'Portfolio')).toBeVisible()
  await folder(page, 'Portfolio').click()
  const branch = page.locator('[data-session-folder="a"]')
  await expect(branch.getByRole('status')).toHaveCount(0)
  await expect(branch.getByText('Portfolio chat', { exact: true })).toHaveCount(
    0,
  )
  await page.getByRole('button', { name: 'Resolve session queries' }).click()
  await expect(
    branch.getByText('Portfolio chat', { exact: true }),
  ).toBeVisible()
  await expect(branch.getByRole('status')).toHaveCount(0)
})

test('folders start collapsed, preload visible pages, and remember expansions on reload', async ({
  page,
}) => {
  await page.goto('/?fixture=session-folders&manySessions&slowSessions')
  await expect(folder(page, 'Portfolio')).toHaveAttribute(
    'aria-expanded',
    'false',
  )
  await expect(folder(page, 'Pinned')).toHaveAttribute('aria-expanded', 'false')
  await expect(folder(page, 'Design')).toHaveCount(0)
  await page.getByRole('button', { name: 'Resolve session queries' }).click()
  await folder(page, 'Portfolio').click()
  await expect(
    sessionPage(page, 'a').getByText('Portfolio chat', { exact: true }),
  ).toBeVisible()
  await expect(folder(page, 'Design')).toHaveAttribute('aria-expanded', 'false')

  await folder(page, 'Design').click()
  const branch = page.locator('[data-session-folder="n"]')
  await expect(branch.getByText('Design chat', { exact: true })).toHaveCount(0)
  await expect(branch.getByRole('status')).toHaveCount(0)
  await page.getByRole('button', { name: 'Resolve session queries' }).click()
  await expect(branch.getByText('Design chat', { exact: true })).toBeVisible()

  await folder(page, 'Portfolio').click()
  await expect.poll(async () => (await loadedPages(page)).a).toBeUndefined()
  await folder(page, 'Portfolio').click()
  await expect(
    sessionPage(page, 'a').getByText('Portfolio chat', { exact: true }),
  ).toBeVisible()

  await page.reload()
  await expect(folder(page, 'Portfolio')).toHaveAttribute(
    'aria-expanded',
    'true',
  )
  await expect(folder(page, 'Corvori')).toHaveAttribute(
    'aria-expanded',
    'false',
  )
  await page.getByRole('button', { name: 'Resolve session queries' }).click()
  await expect(folder(page, 'Design')).toHaveAttribute('aria-expanded', 'true')
})

test('picker preloads before opening without loading indicators and resets additional pages on close', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 1200 })
  await page.goto('/?fixture=session-folders&slowFolders&manyFolders')
  const picker = page.getByRole('combobox', {
    name: 'Session folder',
    exact: true,
  })
  const parentPicker = page.getByRole('combobox', { name: 'Parent folder' })
  const clear = page.getByRole('button', { name: 'Clear session folder' })

  await expect(picker).toBeDisabled()
  await expect(parentPicker).toBeDisabled()
  await expect(clear).toBeDisabled()
  await expect(picker.getByRole('status')).toHaveCount(0)
  await expect(picker).toHaveText('Session folder')
  await expect(picker).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByPlaceholder('Search folders…')).toHaveCount(0)

  await page.evaluate(() =>
    window.dispatchEvent(new Event('resolve-folder-queries')),
  )
  await expect(picker).toBeEnabled()
  await expect(parentPicker).toBeEnabled()
  await expect(clear).toBeEnabled()
  await expect(picker).toHaveText('Portfolio / Design')
  await picker.click()
  await expect(picker).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByRole('option')).toHaveCount(21)
  await expect(
    page.getByRole('option', { name: 'Portfolio', exact: true }),
  ).toBeVisible()
  await expect(page.getByRole('listbox').getByRole('status')).toHaveCount(0)

  await page
    .getByRole('listbox')
    .getByRole('button', { name: 'Show more' })
    .click()
  await page.evaluate(() =>
    window.dispatchEvent(new Event('resolve-folder-queries')),
  )
  await expect(page.getByRole('option')).toHaveCount(41)
  await page
    .getByRole('listbox')
    .getByRole('button', { name: 'Show less' })
    .click()
  await expect(page.getByRole('option')).toHaveCount(21)
  await page.keyboard.press('Escape')
  await expect(picker).toBeFocused()
  await picker.click()
  await expect(picker).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByRole('option')).toHaveCount(21)
  await expect(page.getByRole('listbox').getByRole('status')).toHaveCount(0)
})

test('empty chat keeps the previous welcome inactive until the selected folder loads', async ({
  page,
}) => {
  await page.goto('/?fixture=session-folders&emptyChat&slowFolders')
  const chat = page.getByTestId('empty-chat')
  const welcome = chat.getByRole('region', { name: 'Welcome' })
  const pendingWelcome = chat.locator('[inert][aria-busy="true"]').filter({
    has: page.getByRole('region', { name: 'Welcome' }),
  })
  const genericLabel = 'What’s on your mind?'
  await expect(chat.getByText(genericLabel, { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Resolve session queries' }).click()
  await page
    .getByRole('button', { name: 'Compose in Portfolio', exact: true })
    .click()

  const picker = chat.getByRole('combobox', {
    name: 'Session folder',
    exact: true,
  })
  await expect(picker).toBeDisabled()
  await expect(pendingWelcome).toBeVisible()
  await page.getByRole('button', { name: 'Resolve session queries' }).click()
  await expect(welcome.getByText('Portfolio', { exact: true })).toBeVisible()

  await page
    .getByRole('button', { name: 'Compose in Corvori', exact: true })
    .click()
  await expect(picker).toBeDisabled()
  await expect(pendingWelcome).toBeVisible()
  await page.getByRole('button', { name: 'Resolve session queries' }).click()
  await expect(welcome.getByText('Corvori', { exact: true })).toBeVisible()

  await chat.getByRole('button', { name: 'Clear session folder' }).click()
  await expect(chat.getByText(genericLabel, { exact: true })).toBeVisible()
})

test('composer picker displays the chosen folder while its details load', async ({
  page,
}) => {
  await page.goto(
    '/?fixture=session-folders&emptyChat&slowFolders&manyFolders&folder=a',
  )
  const chat = page.getByTestId('empty-chat')
  const picker = chat.getByRole('combobox', { name: 'Session folder' })
  const resolveQueries = page.getByRole('button', {
    name: 'Resolve session queries',
  })
  await expect(picker).toBeDisabled()
  await resolveQueries.click()
  await expect(picker).toHaveText('Portfolio')

  await picker.click()
  await page
    .getByRole('option', { name: 'Portfolio / Child folder 1', exact: true })
    .click()

  await expect(picker).toHaveAttribute('aria-expanded', 'false')
  await expect(picker).toHaveText('Child folder 1')
  await expect(picker).toHaveAttribute('title', 'Portfolio / Child folder 1')
  await expect(picker).toBeEnabled()
  await expect(
    chat.getByRole('button', { name: 'Create session' }),
  ).toBeDisabled()

  await resolveQueries.click()
  await expect(
    chat.getByRole('button', { name: 'Create session' }),
  ).toBeEnabled()
  await expect(picker).toHaveText('Child folder 1')
})
