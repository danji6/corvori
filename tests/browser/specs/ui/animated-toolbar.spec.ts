import { expect, test } from '@playwright/test'

test('toolbar actions leave the tab order on exit and can reopen', async ({
  page,
}) => {
  await page.goto('/?fixture=ui-layout')
  const toolbar = page.getByTestId('example-toolbar')
  const toggle = toolbar.getByRole('button', { name: 'Toggle extra action' })
  const extra = toolbar.getByRole('button', {
    name: 'Extra action',
    exact: true,
  })
  const item = toolbar.locator('[data-slot="animated-toolbar-item"]')

  await toggle.click()
  await expect(extra).toBeVisible()

  await toggle.focus()
  await page.keyboard.press('Space')
  await expect(item).toHaveAttribute('inert')
  await page.keyboard.press('Tab')
  await expect(
    toolbar.getByRole('button', { name: 'Last action' }),
  ).toBeFocused()
  await expect(item).toHaveCount(0)

  await toggle.focus()
  await page.keyboard.press('Space')
  await expect(extra).toBeVisible()
  await page.keyboard.press('Tab')
  await expect(extra).toBeFocused()
})
