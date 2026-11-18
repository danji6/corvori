import { expect, test } from '@playwright/test'

test('reply quotes jump to their exact text block across loaded windows', async ({
  page,
}) => {
  await page.goto('/?fixture=message-pagination&replies')
  await expect(page.locator('main')).toHaveAttribute(
    'data-position-ready',
    'true',
  )

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
  }
})
