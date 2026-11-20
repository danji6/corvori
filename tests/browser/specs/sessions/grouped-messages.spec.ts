import { type Locator, expect, test } from '@playwright/test'

test('opening a long summary at the bottom brings its start below the nav', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 600 })
  await page.goto('/?fixture=notes&id=notes&compaction')
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

  await summary.click()
  await expect(summary).toHaveAttribute('aria-expanded', 'true')
  await expect
    .poll(async () => (await summary.boundingBox())?.y ?? Infinity)
    .toBeLessThan(120)
  const nav = (await page.getByRole('navigation').boundingBox())!
  expect((await summary.boundingBox())!.y).toBeGreaterThanOrEqual(
    nav.y + nav.height,
  )
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
  await expect(first.locator('[data-slot="code-container"]')).toBeHidden()
  await expect(second.locator('[data-slot="code-container"]')).toBeHidden()
  await expect(rows.nth(2)).toContainText('Original text was not found')

  await first.getByRole('button', { name: 'first.ts' }).focus()
  await page.keyboard.press('Enter')
  await expect(first.locator('[data-slot="code-container"]')).toBeVisible()
  await expect(first).toContainText('newFirst')
  await expect(second.getByRole('button')).toHaveAttribute(
    'aria-expanded',
    'false',
  )
  await second.getByRole('button', { name: 'second.ts' }).click()
  await expect(second.locator('[data-slot="code-container"]')).toBeVisible()
  await expect(second).toContainText('newSecond')
  await first.getByRole('button', { name: 'first.ts' }).click()
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

test('opening work at the bottom holds the viewport, then reveals its details', async ({
  page,
}) => {
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

  const { start, frames } = await work.evaluate(async (button) => {
    const start = scrollY
    const frames: { y: number; opening: boolean }[] = []
    const deadline = performance.now() + 5000
    let stable = 0
    ;(button as HTMLButtonElement).click()
    while (performance.now() < deadline) {
      await new Promise(requestAnimationFrame)
      const opening = Boolean(
        document.querySelector(
          '[data-work-id] [data-slot="virtualized-row-transition"][data-state]',
        ),
      )
      const last = Array.from(document.querySelectorAll('[data-work-id]')).at(
        -1,
      )
      const bottom = last?.getBoundingClientRect().bottom ?? Infinity
      const revealed = !opening && bottom <= innerHeight - 80
      stable = revealed && frames.at(-1)?.y === scrollY ? stable + 1 : 0
      frames.push({ y: scrollY, opening })
      if (stable >= 5) return { start, frames }
    }
    throw new Error('The work details did not scroll into view')
  })

  const opening = frames.filter((frame) => frame.opening)
  expect(opening.length).toBeGreaterThan(0)
  expect(opening.every((frame) => Math.abs(frame.y - start) <= 1)).toBe(true)
  expect(
    frames.every((frame, i) => i === 0 || frame.y >= frames[i - 1].y - 1),
  ).toBe(true)
  expect(frames.at(-1)!.y).toBeGreaterThan(start + 20)
  const nav = (await page.getByRole('navigation').boundingBox())!
  expect((await work.boundingBox())!.y).toBeGreaterThanOrEqual(
    nav.y + nav.height,
  )
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
    await page.goto('/?fixture=notes&id=notes&tailWork')
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

    const { originalY, positions } = await collapseWorkAtPhase(work, phase)
    await expect(work).toHaveAttribute('aria-expanded', 'false')
    expect(
      Math.max(...positions.map((y) => Math.abs(y - originalY))),
    ).toBeLessThanOrEqual(1)
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

    const positions = [scrollY]
    for (let index = 0; index < 45; index++) {
      await frame()
      positions.push(scrollY)
    }
    return { originalY, positions }
  }, phase)
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
