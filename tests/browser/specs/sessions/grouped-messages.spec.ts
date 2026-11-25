import { type Locator, expect, test } from '@playwright/test'

import { expectAnchoredExpansion } from '../../transcript-expansion'

test('keeps old names in the transcript and search while avatars update', async ({
  page,
}) => {
  await page.route('**/avatar-*.svg', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="green"/></svg>',
    }),
  )
  await page.goto('/?fixture=notes&id=notes&liveAuthors')

  const header = page
    .locator('[data-slot="message-header"]')
    .filter({ hasText: 'Original author' })
  await expect(header.locator('img')).toHaveAttribute(
    'src',
    /avatar-before\.svg$/,
  )
  const quote = page.locator('[data-slot="reply-quote"]')
  await expect(quote).toContainText('Original author')

  await page.keyboard.press('Control+Shift+f')
  const search = page.getByRole('dialog', { name: 'Search messages' })
  await search.getByRole('textbox').fill('answer')
  await expect(search.getByText('Original author')).toBeVisible()

  await page.evaluate(() =>
    window.dispatchEvent(new Event('rename-fixture-author')),
  )
  await expect(search.getByText('Original author')).toBeVisible()
  await expect(search.locator('img')).toHaveAttribute(
    'src',
    /avatar-after\.svg$/,
  )
  await page.keyboard.press('Escape')
  const composer = page.locator('[data-slot="editor"]')
  await expect(composer).toBeFocused()

  await expect(header.locator('img')).toHaveAttribute(
    'src',
    /avatar-after\.svg$/,
  )
  await expect(quote).toContainText('Original author')

  const options = (name: string) =>
    page.getByRole('button', { name: `Options for ${name}` })
  const edit = page.getByRole('menuitem', { name: 'Edit...', exact: true })
  await options('Renamed author').click()
  await edit.click()
  const editor = page.getByRole('dialog', { name: 'Edit session profile' })
  const name = editor.getByRole('textbox', { name: 'Name' })
  await expect(name).toHaveValue('Renamed author')
  await name.fill('Only in this session')
  await editor.getByRole('button', { name: 'Save' }).click()
  await expect(composer).toBeFocused()
  await options('Only in this session').waitFor()
  await page.evaluate(() =>
    window.dispatchEvent(new Event('send-fixture-author-message')),
  )
  const newHeader = page
    .locator('[data-slot="message-header"]')
    .filter({ hasText: 'Only in this session' })
  await expect(newHeader).toBeVisible()
  await expect(header).toBeVisible()
  await options('Only in this session').click()
  await edit.click()
  await expect(name).toHaveValue('Only in this session')
  await name.clear()
  await expect(name).toHaveAttribute('placeholder', 'Anonymous')
  await editor.getByRole('button', { name: 'Save' }).click()
  await expect(composer).toBeFocused()
  await options('Anonymous').click()
  await edit.click()
  await expect(name).toHaveValue('')
  await expect(name).toHaveAttribute('placeholder', 'Anonymous')
  await editor.getByRole('button', { name: 'Cancel' }).click()
  await expect(newHeader).toBeVisible()
  await expect(quote).toContainText('Original author')
})

test('the participant menu removes members and unlinks agents', async ({
  page,
}) => {
  await page.goto('/?fixture=notes&id=notes&liveAuthors')

  const guestOptions = page.getByRole('button', { name: 'Options for Guest' })
  await guestOptions.click()
  const menu = page.getByRole('menu')
  const remove = menu.getByRole('menuitem', { name: 'Remove' })
  await expect(menu.getByRole('menuitem', { name: 'Edit...' })).toHaveCount(0)
  await remove.click()
  const confirmation = page.getByRole('alertdialog', { name: 'Remove member?' })
  await confirmation.getByRole('button', { name: 'Cancel' }).click()
  await guestOptions.click()
  await remove.click()
  await confirmation.getByRole('button', { name: 'Remove' }).click()
  await expect(guestOptions).toHaveCount(0)

  const agentOptions = page.getByRole('button', {
    name: 'Options for Original author',
  })
  await agentOptions.click()
  await expect(menu.getByRole('menuitem', { name: 'Edit...' })).toBeVisible()
  await remove.click()
  await expect(agentOptions).toHaveCount(0)
  await expect(page.getByRole('combobox', { name: 'Link agent' })).toBeVisible()
})

test('a long summary grows upward at the bottom', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 600 })
  await page.goto('/?fixture=notes&id=notes&compaction&composer&intoView')
  const composer = page.locator('[data-slot="chat-box"]')
  await expect(composer).toBeInViewport({ ratio: 1 })
  const summary = page.getByRole('button', { name: /^Summary\b/ })
  await expect(summary).toBeInViewport({ ratio: 1 })
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          scrollY > 0 &&
          document.documentElement.scrollHeight - scrollY - innerHeight <= 1,
      ),
    )
    .toBe(true)
  expect((await summary.boundingBox())!.y).toBeGreaterThan(120)

  await expectAnchoredExpansion(summary, 'bottom')
  const paragraphs = page.getByText('Summary of the completed work.', {
    exact: true,
  })
  await expect(paragraphs.last()).toBeInViewport()
  await expect(composer).toBeInViewport({ ratio: 1 })
})

test('opens a lone thought directly from the sender header', async ({
  page,
}) => {
  await page.goto('/?fixture=notes&id=notes&thinkingWork=single')

  const header = page.getByRole('button', { name: 'Toggle latest thinking' })
  await expect(
    header.getByText('Thought for 10.0s', { exact: true }),
  ).toBeVisible()
  await expect(
    page.getByText('Thought for 10.0s', { exact: true }),
  ).toHaveCount(1)
  await expect(page.locator('[data-slot="work-block"]')).toHaveCount(0)
  await expect(page.locator('[data-slot="reasoning-block"]')).toHaveCount(0)
  const message = page.getByText('Finished thinking.')
  await expect(message).toBeVisible()
  await header.click()
  await expect(header).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByText('First thinking block.')).toBeVisible()
})

test('the sender menu includes the gutter avatar in the highlight only with backgrounds off', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.goto('/?fixture=notes&id=notes&groupedReply&backgrounds')
  const headers = page.locator('[data-slot="message-header"]')
  const avatar = headers.first().locator('[data-slot="avatar"]')
  const work = page.locator('[data-slot="work-block"]')
  const backgrounds = page.locator('[data-slot="message-background"]')
  const highlight = page.locator('[data-slot="message-highlight"]')
  const answer = page.getByText('Content for answer', { exact: true })
  const next = page.getByText('Content for next', { exact: true })
  await expect(headers).toHaveCount(2)
  await expect(backgrounds.first()).toBeVisible()
  await expect(work).toHaveCount(2)
  await expect(work.last()).toHaveAttribute('aria-expanded', 'false')

  await avatar.click({ button: 'right' })
  await expect(
    page.getByRole('menuitem', { name: 'Delete Message' }),
  ).toBeVisible()
  await expect(highlight).toHaveCount(1)
  await expect
    .poll(() => bottomOf(highlight))
    .toBeGreaterThanOrEqual(await bottomOf(answer))
  const outline = (await highlight.boundingBox())!
  const body = (await answer.boundingBox())!
  const avatarBox = (await avatar.boundingBox())!
  expect(outline.x).toBeGreaterThanOrEqual(avatarBox.x + avatarBox.width)
  expect(outline.x + outline.width).toBeGreaterThanOrEqual(body.x + body.width)
  expect(await bottomOf(highlight)).toBeLessThan(await bottomOf(next))

  await page.keyboard.press('Escape')
  await expect(highlight).toHaveCount(0)
  await page.getByText('Appearance', { exact: true }).click()
  await page.getByRole('switch', { name: 'Message backgrounds' }).click()
  await page.getByRole('button', { name: 'Save appearance' }).click()
  await expect(backgrounds).toHaveCount(0)

  await avatar.click({ button: 'right' })
  await expect
    .poll(() => bottomOf(highlight))
    .toBeGreaterThanOrEqual(await bottomOf(answer))
  expect((await highlight.boundingBox())!.x).toBeLessThanOrEqual(
    (await avatar.boundingBox())!.x,
  )
})

test('the avatar highlight spans the message while the thinking menu scopes its block', async ({
  page,
}) => {
  await page.goto('/?fixture=notes&id=notes&thinkingWork=single')
  const header = page.locator('[data-slot="message-header"]')
  const highlight = page.locator('[data-slot="message-highlight"]')
  const footer = page.locator('[data-slow="message-footer"]')

  await header.locator('[data-slot="avatar"]').click({ button: 'right' })
  await expect(footer).toBeVisible()
  await expect
    .poll(() => bottomOf(highlight))
    .toBeGreaterThanOrEqual(await bottomOf(footer))
  await page.keyboard.press('Escape')
  await expect(highlight).toHaveCount(0)

  await header
    .getByRole('button', { name: 'Toggle latest thinking' })
    .click({ button: 'right' })
  await expect(highlight).toBeVisible()
  expect(await bottomOf(highlight)).toBeLessThan(
    await bottomOf(page.getByText('Finished thinking.')),
  )
})

async function bottomOf(locator: Locator) {
  const box = await locator.boundingBox()
  return box ? box.y + box.height : NaN
}

for (const mixed of [false, true]) {
  test(`work sums thinking durations and reveals every thinking block (mixed=${mixed})`, async ({
    page,
  }) => {
    await page.goto(
      `/?fixture=notes&id=notes&thinkingWork${mixed ? '&mixedThinking' : ''}`,
    )
    const work = page.locator('[data-slot="work-block"]')
    await expect(work).toHaveText(
      mixed ? 'Read 1 file, thought for 1m12s' : 'Thought for 1m12s',
      { useInnerText: true },
    )
    await expect(
      page.locator('[data-slot="reasoning-highlight"]'),
    ).toContainText('Thought for 1m2s')
    await expect(page.locator('[data-slow="message-footer"]')).toContainText(
      '2m26s',
    )
    const blocks = page.locator('[data-slot="reasoning-block"]')
    await expect(blocks).toHaveCount(0)
    await work.click()
    await expect(blocks).toHaveCount(2)
    await expect(blocks.nth(0)).toContainText('Thought for 10.0s')
    await expect(blocks.nth(1)).toContainText('Thought for 1m2s')
    await blocks.nth(0).getByRole('button').click()
    await blocks.nth(1).getByRole('button').click()
    await expect(blocks.nth(0)).toContainText('First thinking block.')
    await expect(blocks.nth(1)).toContainText('Second thinking block.')
    await work.click()
    await expect(blocks).toHaveCount(0)
    await work.click()
    await expect(blocks.nth(0).getByText('First thinking block.')).toBeVisible()
    await expect(
      blocks.nth(1).getByText('Second thinking block.'),
    ).toBeVisible()
  })
}

function headerGeometry(trigger: Locator) {
  return trigger.evaluate((button) => {
    const header = button.parentElement!.getBoundingClientRect()
    const block = button.closest('[data-open]')!.getBoundingClientRect()
    const { top, left } = button.getBoundingClientRect()
    return {
      height: header.height,
      top: top - block.top,
      left: left - block.left,
    }
  })
}

test('expanding and collapsing todos keeps the header in place', async ({
  page,
}) => {
  await page.goto('/?fixture=notes&id=notes&todoWork')
  await page.locator('[data-slot="work-block"]').click()
  const trigger = page.getByRole('button', { name: /^Update todos/ })
  const task = page.getByText('Review the changes', { exact: true })
  await expect(trigger).toBeVisible()
  const collapsed = await headerGeometry(trigger)
  await trigger.click()
  await expect(task).toBeVisible()
  expect(await headerGeometry(trigger)).toEqual(collapsed)
  const item = await page.getByRole('listitem').boundingBox()
  expect(item!.x).toBeGreaterThan((await trigger.boundingBox())!.x + 20)
  await trigger.click()
  await expect(task).toBeHidden()
  expect(await headerGeometry(trigger)).toEqual(collapsed)
})

test('transcript chevrons reveal on hover and keyboard focus', async ({
  page,
}) => {
  await page.goto('/?fixture=notes&id=notes&fileChanges')
  const work = page.locator('[data-slot="work-block"]')
  const chevron = (trigger: Locator) =>
    trigger.locator('.chat-collapsible-chevron')
  await expect(chevron(work)).toHaveCSS('opacity', '0')
  await expect(chevron(work)).toHaveCSS('transition-property', /opacity/)
  await work.hover()
  await expect(chevron(work)).toHaveCSS('opacity', '1')
  await work.click()

  const first = page.getByRole('button', { name: 'first.ts', expanded: false })
  const second = page.getByRole('button', { name: 'second.ts' })
  await first.hover()
  await expect(chevron(work)).toHaveCSS('opacity', '0')
  await expect(chevron(first)).toHaveCSS('opacity', '1')
  await expect(chevron(second)).toHaveCSS('opacity', '0')

  await page.mouse.move(0, 0)
  await first.focus()
  await page.keyboard.press('Tab')
  await expect(second).toBeFocused()
  await expect(chevron(first)).toHaveCSS('opacity', '0')
  await expect(chevron(second)).toHaveCSS('opacity', '1')

  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(chevron(second)).toHaveCSS('transition-duration', '0s')
})

test.describe('touch transcript', () => {
  test.use({ hasTouch: true })

  test('keeps disclosure chevrons visible without hover', async ({ page }) => {
    await page.goto('/?fixture=notes&id=notes&fileChanges')
    const work = page.locator('[data-slot="work-block"]')
    await expect(work.locator('.chat-collapsible-chevron')).toHaveCSS(
      'opacity',
      '1',
    )
    await work.tap()
    await expect(work).toHaveAttribute('aria-expanded', 'true')
  })
})

test('file changes share a list with independent, persistent diff toggles', async ({
  page,
}) => {
  await page.goto('/?fixture=notes&id=notes&fileChanges')
  const work = page.locator('[data-slot="work-block"]')
  await work.click()
  await expect(
    page.locator('[data-slot="virtualized-row-transition"][data-state]'),
  ).toHaveCount(0)
  const group = page.locator('[data-slot="file-change-group"]')
  await expect(group).toContainText('Changed 3 files')
  const rows = group.getByRole('listitem')
  await expect(rows).toHaveCount(3)
  const first = rows.nth(0)
  const second = rows.nth(1)
  const firstTrigger = first.getByRole('button', { name: 'first.ts' })
  await expect(first.locator('[data-slot="code-container"]')).toBeHidden()
  await expect(second.locator('[data-slot="code-container"]')).toBeHidden()
  await expect(rows.nth(2)).toContainText('Original text was not found')

  const collapsed = await headerGeometry(firstTrigger)
  await firstTrigger.focus()
  await page.keyboard.press('Enter')
  await expect(first.locator('[data-slot="code-container"]')).toBeVisible()
  await expect(first).toContainText('newFirst')
  await expect
    .poll(async () => (await headerGeometry(firstTrigger)).top)
    .toBeGreaterThan(collapsed.top)
  expect((await headerGeometry(firstTrigger)).height).toBe(collapsed.height)
  await expect(second.getByRole('button')).toHaveAttribute(
    'aria-expanded',
    'false',
  )
  await second.getByRole('button', { name: 'second.ts' }).click()
  await expect(second.locator('[data-slot="code-container"]')).toBeVisible()
  await expect(second).toContainText('newSecond')
  await firstTrigger.click()
  await expect(first.locator('[data-slot="code-container"]')).toBeHidden()
  await expect(first.getByRole('button')).toHaveAttribute(
    'aria-expanded',
    'false',
  )
  await expect(second.getByRole('button')).toHaveAttribute(
    'aria-expanded',
    'true',
  )

  await work.click()
  await expect(group).toBeHidden()
  await work.click()
  await expect(second.getByRole('button')).toHaveAttribute(
    'aria-expanded',
    'true',
  )
  await expect(second).toContainText('newSecond')
})

test('work details grow upward at the bottom', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 530 })
  await page.goto('/?fixture=notes&id=notes&fileChanges&longShell')
  const work = page.locator('[data-slot="work-block"]')
  await expect(work).toBeInViewport({ ratio: 1 })
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollHeight - innerHeight - scrollY,
      ),
    )
    .toBeLessThanOrEqual(1)

  const { start, end, frames } = await work.evaluate(async (button) => {
    const start = scrollY
    const frames: { bottomDistance: number; opening: boolean }[] = []
    const deadline = performance.now() + 5000
    let lastHeight = -1
    let stable = 0
    ;(button as HTMLButtonElement).click()
    while (performance.now() < deadline) {
      await new Promise(requestAnimationFrame)
      const opening = Boolean(
        document.querySelector(
          '[data-work-id] [data-slot="virtualized-row-transition"][data-state]',
        ),
      )
      const hasDetails = Boolean(document.querySelector('[data-work-id]'))
      const height = document.documentElement.scrollHeight
      stable = hasDetails && !opening && height === lastHeight ? stable + 1 : 0
      lastHeight = height
      frames.push({ bottomDistance: height - innerHeight - scrollY, opening })
      if (stable >= 8) return { start, end: scrollY, frames }
    }
    throw new Error('The work details did not finish expanding')
  })

  expect(frames.some((frame) => frame.opening)).toBe(true)
  expect(frames.every((frame) => Math.abs(frame.bottomDistance) <= 1)).toBe(
    true,
  )
  expect(end).toBeGreaterThan(start + 20)
})

test('preparing a work summary keeps the existing reply visible in place', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 690 })
  await page.goto('/?fixture=notes&id=notes&tailWork')
  const work = page.locator('[data-slot="work-block"]')
  const reply = page
    .getByText('Regression checks passed.', { exact: true })
    .first()
  await expect(work).toBeInViewport({ ratio: 1 })
  await expect(reply).toBeInViewport()

  const replyKey = await reply.evaluate((element) =>
    element.closest('[data-row-key]')!.getAttribute('data-row-key')!,
  )
  const { before, preparing } = await work.evaluate(async (trigger, key) => {
    const list = trigger.closest('[data-row-key]')!.parentElement!
    const sample = () => {
      const row = list.querySelector(`[data-row-key="${CSS.escape(key)}"]`)
      return {
        visible: !!row && getComputedStyle(row).visibility === 'visible',
        top: row?.getBoundingClientRect().top ?? null,
        scroll: scrollY,
        height: document.documentElement.scrollHeight,
      }
    }

    const before = sample()
    const preparing = await new Promise<ReturnType<typeof sample>>(
      (resolve) => {
        const observer = new MutationObserver(() => {
          if (!list.querySelector('[data-state="preparing"]')) return
          observer.disconnect()
          resolve(sample())
        })
        observer.observe(list, { childList: true })
        ;(trigger as HTMLButtonElement).click()
      },
    )
    return { before, preparing }
  }, replyKey)

  expect(before.visible).toBe(true)
  expect(preparing.visible).toBe(true)
  expect(Math.abs(preparing.top! - before.top!)).toBeLessThanOrEqual(1)
  expect(Math.abs(preparing.scroll - before.scroll)).toBeLessThanOrEqual(1)
  expect(Math.abs(preparing.height - before.height)).toBeLessThanOrEqual(1)
})

for (const phase of ['preparing', 'opening', 'open'] as const) {
  test(`collapsing work at the tail preserves position without bouncing (phase=${phase})`, async ({
    page,
  }) => {
    await page.goto('/?fixture=notes&id=notes&tailWork&singleEdit')
    const work = page.locator('[data-slot="work-block"]')
    await expect(work).toBeVisible()
    // Stop auto-follow before setting the starting position.
    await page.mouse.wheel(0, -1)
    await expect
      .poll(() =>
        page.evaluate(() => {
          const bottom = document.documentElement.scrollHeight - innerHeight
          window.scrollTo(0, bottom)
          return bottom - scrollY
        }),
      )
      .toBeLessThanOrEqual(1)
    await expect(work).toBeInViewport({ ratio: 1 })

    const { originalY, settledY, distances } = await collapseWorkAtPhase(
      work,
      phase,
    )
    await expect(work).toHaveAttribute('aria-expanded', 'false')
    expect(Math.max(...distances.map(Math.abs))).toBeLessThanOrEqual(1)
    expect(Math.abs(settledY - originalY)).toBeLessThanOrEqual(1)
  })
}

async function collapseWorkAtPhase(
  work: Locator,
  phase: 'preparing' | 'opening' | 'open',
) {
  return work.evaluate(async (trigger, phase) => {
    const button = trigger as HTMLButtonElement
    const list = button.closest('[data-row-key]')!.parentElement!
    const selector = '[data-work-id] [data-slot="virtualized-row-transition"]'
    const rowInPhase =
      phase === 'open'
        ? `${selector}:not([data-state])`
        : `${selector}[data-state="${phase}"]`
    const originalY = scrollY
    const frame = () => new Promise(requestAnimationFrame)

    // Close in the same rendering cycle that commits the requested phase.
    await new Promise<void>((resolve) => {
      const observer = new MutationObserver(() => {
        if (!list.querySelector(rowInPhase)) return
        observer.disconnect()
        button.click()
        resolve()
      })
      observer.observe(list, {
        attributes: true,
        attributeFilter: ['data-state'],
        childList: true,
        subtree: true,
      })
      button.click()
    })

    const bottomDistance = () =>
      document.documentElement.scrollHeight - innerHeight - scrollY
    const distances = []
    for (let index = 0; index < 45; index++) {
      await frame()
      distances.push(bottomDistance())
    }
    return { originalY, settledY: scrollY, distances }
  }, phase)
}

test('the gap above the next work summary shrinks with the closing details', async ({
  page,
}) => {
  await page.goto('/?fixture=notes&id=notes&groupedWork')
  const first = page.locator('[data-slot="work-block"]').first()
  const detail = page.locator('[data-work-id]')
  const closing = detail.locator('[data-state="closing"]')
  const gap = () => gapAfterWorkSummary(first)
  const collapsedGap = await gap()

  await first.click()
  await expect(detail).toHaveCount(1)
  await expect(detail.locator('[data-state]')).toHaveCount(0)
  expect(await gap()).toBeGreaterThan(collapsedGap)

  await first.click()
  await closing.evaluate((row) => {
    for (const animation of row.getAnimations() as CSSTransition[]) {
      if (animation.transitionProperty === 'opacity') animation.pause()
      else animation.finish()
    }
  })
  await expect.poll(gap).toBeCloseTo(collapsedGap, 0)
  await closing.evaluate((row) => {
    for (const animation of row.getAnimations()) animation.finish()
  })
  await expect(detail).toHaveCount(0)
})

function gapAfterWorkSummary(summary: Locator) {
  return summary.evaluate((button) => {
    const list = button.closest('[data-row-key]')!.parentElement!
    const next = list.querySelectorAll('[data-slot="work-block"]')[1]!
    return (
      next.getBoundingClientRect().top - button.getBoundingClientRect().bottom
    )
  })
}

test('closing work at the expanded bottom waits for rows without a scroll jump', async ({
  page,
}) => {
  await page.clock.install()
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/?fixture=notes&id=notes&tailWork&singleEdit')
  const work = page.locator('[data-slot="work-block"]')
  const rows = page.locator('[data-work-id]')
  await work.evaluate((button) => (button as HTMLButtonElement).click())
  await expect(rows).toHaveCount(2)
  await expect(rows.getByRole('button', { expanded: false })).toHaveCount(2)
  await expect(
    rows.locator('[data-slot="virtualized-row-transition"][data-state]'),
  ).toHaveCount(0)
  await expect
    .poll(() =>
      page.evaluate(() => {
        const height = document.documentElement.scrollHeight
        window.scrollTo(0, height)
        return document.documentElement.scrollHeight - innerHeight - scrollY
      }),
    )
    .toBeLessThanOrEqual(1)
  await expect(work).toBeInViewport({ ratio: 1 })

  const closing = rows.locator(
    '[data-slot="virtualized-row-transition"][data-state="closing"]',
  )
  const paused = await pauseWorkCollapse(work)
  expect(paused).toBe(2)
  await page.clock.runFor(300)
  await expect(closing).toHaveCount(2)

  const { removalY, settledY, distanceFromBottom } =
    await finishWorkCollapse(closing)
  expect(distanceFromBottom).toBeLessThanOrEqual(1)
  expect(removalY).toBeGreaterThanOrEqual(settledY - 1)
})

async function pauseWorkCollapse(work: Locator) {
  return work.evaluate(async (button) => {
    ;(button as HTMLButtonElement).click()
    await new Promise(requestAnimationFrame)
    const closing = document.querySelectorAll('[data-state="closing"]')
    return [...closing].filter((row) => {
      const animations = row.getAnimations()
      for (const animation of animations) {
        animation.pause()
        animation.currentTime = 50
      }
      return animations.length > 0
    }).length
  })
}

async function finishWorkCollapse(closing: Locator) {
  return closing.first().evaluate(async (row) => {
    const list = row.closest('[data-work-id]')!.parentElement!
    const removed = new Promise<number>((resolve) => {
      const observer = new MutationObserver(() => {
        if (list.querySelector('[data-work-id]')) return
        observer.disconnect()
        resolve(window.scrollY)
      })
      observer.observe(list, { childList: true })
    })
    for (const child of list.querySelectorAll('[data-state="closing"]')) {
      for (const animation of child.getAnimations()) animation.play()
    }
    const removalY = await removed
    await new Promise(requestAnimationFrame)
    await new Promise(requestAnimationFrame)
    return {
      removalY,
      settledY: window.scrollY,
      distanceFromBottom:
        document.documentElement.scrollHeight - innerHeight - scrollY,
    }
  })
}
