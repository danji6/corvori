import { expect, test } from '@playwright/test'

test('reply quotes jump to their exact text block across loaded windows', async ({
  page,
}) => {
  await page.goto('/?fixture=message-pagination&replies')
  await expect(page.locator('main')).toHaveAttribute(
    'data-position-ready',
    'true',
  )
  await page.clock.install()

  const highlight = page.locator('[data-slot="message-highlight"]')
  for (const segmentIndex of [4, 1, 4]) {
    await page
      .locator('[data-slot="reply-quote"]')
      .filter({
        hasText: `Quoted text in segment ${segmentIndex}`,
      })
      .click()

    const block = page.locator('article').filter({
      hasText: `Quoted text in segment ${segmentIndex}`,
    })
    await expect(block).toBeVisible()
    await expect
      .poll(() =>
        block.evaluate((element) =>
          Math.round(
            element.closest('[data-row-key]')!.getBoundingClientRect().top,
          ),
        ),
      )
      .toBe(64)
    await expect(highlight).toBeVisible()
    await block.click()
  }

  await page.clock.runFor(2000)
  await expect(highlight).toBeVisible()

  const lastBlock = page
    .locator('article')
    .filter({ hasText: 'Quoted text in segment 4' })
  const scrollDeltas = await lastBlock.evaluate((block) => {
    const overlay = document.querySelector('[data-slot="message-highlight"]')!
    const blockTop = block.getBoundingClientRect().top
    const overlayTop = overlay.getBoundingClientRect().top

    window.scrollBy({ top: 48, behavior: 'instant' })

    return {
      block: block.getBoundingClientRect().top - blockTop,
      highlight: overlay.getBoundingClientRect().top - overlayTop,
    }
  })
  expect(scrollDeltas).toEqual({ block: -48, highlight: -48 })
})
