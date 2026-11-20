import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.goto('/?fixture=ui-layout')
})

for (const streaming of [false, true]) {
  test(`opening a thinking block near the bottom reveals its start (streaming=${streaming})`, async ({
    page,
  }) => {
    if (streaming)
      await page.getByRole('button', { name: 'Stream off' }).click()
    const trigger = page.getByRole('button', { name: 'Thinking' })
    await trigger.click()
    await expect
      .poll(async () => {
        const box = await trigger.boundingBox()
        return Math.abs((box?.y ?? -1) - 64)
      })
      .toBeLessThan(2)
    if (!streaming) return
    await expect(
      page.getByText('Reasoning line 30', { exact: true }),
    ).toBeAttached()
    expect(Math.abs((await trigger.boundingBox())!.y - 64)).toBeLessThan(2)
  })
}

test('wheel input cancels revealing a streaming block', async ({ page }) => {
  await page.getByRole('button', { name: 'Stream off' }).click()
  const trigger = page.getByRole('button', { name: 'Thinking' })
  await trigger.click()
  await page.mouse.move(400, 300)
  await page.mouse.wheel(0, -100)
  await expect(
    page.getByText('Reasoning line 60', { exact: true }),
  ).toBeAttached()
  expect((await trigger.boundingBox())!.y).toBeGreaterThan(300)
})
