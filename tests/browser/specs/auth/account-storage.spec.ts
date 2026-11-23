import { expect, test } from '@playwright/test'

test('switching browser accounts isolates preferences, draft text and files, and shared-chat scroll', async ({
  page,
}) => {
  await page.goto('/?fixture=account-storage')
  const account = page.getByLabel('Account', { exact: true })
  const pinned = page.getByRole('button', { name: 'Pin sidebar' })
  const draft = page.getByRole('textbox', { name: 'Composer draft' })
  const attachments = page.getByLabel('Draft attachments')
  const scroll = page.getByLabel('Scroll offset')
  const aliceSettings = () =>
    page.evaluate(() => localStorage.getItem('corvori-ui-settings:alice'))

  await expect(account).toHaveText('alice')
  await pinned.click()
  await page.getByRole('button', { name: 'Save scroll position' }).click()
  const savedSettings = await aliceSettings()
  expect(savedSettings).toBeTruthy()

  await draft.fill('Draft from Alice')
  await page.getByRole('button', { name: 'Attach draft file' }).click()
  await expect(attachments).toHaveText('Draft.png')
  await expect
    .poll(() =>
      page.evaluate(async () => {
        return new Promise<boolean>((resolve, reject) => {
          const open = indexedDB.open('corvori-composer-drafts')
          open.onerror = () => reject(open.error)
          open.onsuccess = () => {
            const db = open.result
            const record = db
              .transaction('attachments')
              .objectStore('attachments')
              .get(JSON.stringify(['alice', 'shared-chat']))
            record.onsuccess = () => {
              db.close()
              resolve(Boolean(record.result?.attachments.length))
            }
            record.onerror = () => {
              db.close()
              reject(record.error)
            }
          }
        })
      }),
    )
    .toBe(true)
  await expect
    .poll(() =>
      page.evaluate(() =>
        localStorage.getItem('corvori-composer-drafts:alice'),
      ),
    )
    .toContain('Draft from Alice')
  expect(await aliceSettings()).toBe(savedSettings)

  await page.getByRole('button', { name: 'Schedule draft and switch' }).click()
  await expect(account).toHaveText('bob')
  await expect(pinned).toHaveAttribute('aria-pressed', 'false')
  await expect(draft).toHaveValue('')
  await expect(
    page.getByRole('button', { name: 'Attach draft file' }),
  ).toBeEnabled()
  await expect(attachments).toHaveText('')
  await expect(scroll).toHaveText('0')

  await draft.fill('Draft from Bob')
  await expect
    .poll(() =>
      page.evaluate(() => localStorage.getItem('corvori-composer-drafts:bob')),
    )
    .toContain('Draft from Bob')

  await page
    .getByRole('button', { name: 'Switch account', exact: true })
    .click()
  await expect(account).toHaveText('alice')
  await expect(pinned).toHaveAttribute('aria-pressed', 'true')
  await expect(draft).toHaveValue('Draft from Alice')
  await expect(attachments).toHaveText('Draft.png')
  await expect(scroll).toHaveText('48')
})
