import { expect, test } from '@playwright/test'

test('warns about a long evaluation after reload and offers Stop before a stream exists', async ({
  page,
}) => {
  await page.clock.install()
  await page.addInitScript(() => {
    if (sessionStorage.getItem('fixture-evaluation-seeded')) return
    sessionStorage.setItem('fixture-evaluation-seeded', 'true')
    sessionStorage.setItem('fixture-evaluation-started-at', String(Date.now()))
  })
  await page.goto('/?fixture=notes&id=notes&contextReset&promptEvaluation=1')
  const warning = page.getByText('Prompt evaluation is taking too long...')
  const stop = page.getByRole('button', { name: 'Stop', exact: true })
  await expect(stop).toBeVisible()
  await expect(warning).toHaveCount(0)
  await page.clock.fastForward(5_000)
  await expect(warning).toBeVisible()

  await page.reload()
  await expect(warning).toBeVisible()
  await stop.click()
  await expect(warning).toHaveCount(0)
  await expect(stop).toHaveCount(0)
})
