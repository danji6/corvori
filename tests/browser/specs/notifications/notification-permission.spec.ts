import { type Page, expect, test } from '@playwright/test'

async function openWithUndecidedPermission(
  page: Page,
  decision: NotificationPermission,
) {
  await page.addInitScript((decision) => {
    Reflect.set(window, 'notificationPermissionRequests', [])
    Reflect.set(window, 'notificationPermissionDecision', decision)
    Object.defineProperty(window, 'Notification', {
      value: class {
        static permission: NotificationPermission = 'default'
        static requestPermission = async () => {
          Reflect.get(window, 'notificationPermissionRequests').push(
            navigator.userActivation.isActive,
          )
          this.permission = Reflect.get(
            window,
            'notificationPermissionDecision',
          )
          return this.permission
        }
      },
    })
  }, decision)
  await page.goto('/?fixture=notifications&id=other-chat')
  await expect(inboxButton(page)).toBeVisible()
}

const inboxButton = (page: Page) =>
  page.getByRole('button', { name: 'Notifications', exact: true })

const permissionRequests = (page: Page) =>
  page.evaluate(() => Reflect.get(window, 'notificationPermissionRequests'))

async function openSettings(page: Page) {
  await inboxButton(page).click()
  await page.getByRole('button', { name: 'Notification settings' }).click()
  return page.getByRole('switch', { name: 'Enable desktop notifications' })
}

test('the first interaction requests native notification permission', async ({
  page,
}) => {
  await openWithUndecidedPermission(page, 'granted')
  await page.evaluate(() => window.dispatchEvent(new MouseEvent('click')))
  expect(await permissionRequests(page)).toEqual([])

  await expect(await openSettings(page)).toBeChecked()
  expect(await permissionRequests(page)).toEqual([true])
})

test('blocking the native prompt prevents another automatic request', async ({
  page,
}) => {
  await openWithUndecidedPermission(page, 'denied')
  const toggle = await openSettings(page)
  await expect(toggle).toBeDisabled()
  expect(await permissionRequests(page)).toEqual([true])

  await page.reload()
  await expect(await openSettings(page)).not.toBeChecked()
  expect(await permissionRequests(page)).toEqual([])
})

test('an unanswered native prompt can retry once after reload and allows manual opt-in', async ({
  page,
}) => {
  await page.addInitScript(() => {
    // Older versions saved handled before the browser returned a decision.
    const key = 'corvori:desktop-permission-prompt'
    if (localStorage.getItem(key) === null) {
      localStorage.setItem(key, JSON.stringify({ handled: true }))
    }
  })
  await openWithUndecidedPermission(page, 'default')
  await page.keyboard.press('Tab')
  await expect(await openSettings(page)).not.toBeChecked()
  expect(await permissionRequests(page)).toEqual([true])

  await page.reload()
  const toggle = await openSettings(page)
  await expect(toggle).not.toBeChecked()
  expect(await permissionRequests(page)).toEqual([true])

  await page.evaluate(() =>
    Reflect.set(window, 'notificationPermissionDecision', 'granted'),
  )
  await toggle.click()
  await expect(toggle).toBeChecked()
  expect(await permissionRequests(page)).toEqual([true, true])
})
