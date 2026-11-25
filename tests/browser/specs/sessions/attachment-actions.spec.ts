import { expect, test } from '@playwright/test'

const fixture = '/?fixture=notes&id=notes&composer&ungrouped&attachmentActions'
const fileRow =
  '[data-slot="message-row"][data-message-id="file-message"]:has([data-slot="file-block"])'
const singleRow =
  '[data-slot="message-row"][data-message-id="single-attachment"]:has([data-slot="file-block"])'
const thumbnail = '[data-slot="reply-attachment-thumbnail"]'

test.beforeEach(async ({ page }) => {
  await page.route('https://storage.example.test/*.png', (route) =>
    route.fulfill({
      contentType: 'image/png',
      body: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOh0AAAAASUVORK5CYII=',
        'base64',
      ),
    }),
  )
})

test('a guest can reply to an attachment-only message from every menu surface', async ({
  page,
}) => {
  await page.goto(`${fixture}&attachmentGuest`)
  const row = page.locator(fileRow)
  const first = row.getByRole('img', { name: 'first.png' })
  const menu = page.getByRole('menu')

  await first.click({ button: 'right' })
  await expect(menu.getByRole('menuitem')).toHaveText([
    'Download',
    'Copy Link',
    'Reply',
  ])
  await page.keyboard.press('Escape')

  const sender = page
    .locator('[data-slot="message-row"][data-message-id="file-message"]')
    .locator('[data-slot="avatar"]')
  await sender.click({ button: 'right' })
  await expect(menu.getByRole('menuitem')).toHaveText(['Reply'])
  await page.keyboard.press('Escape')

  await row.click({ button: 'right', position: { x: 350, y: 48 } })
  await expect(menu.getByRole('menuitem')).toHaveText(['Reply'])
  await menu.getByRole('menuitem', { name: 'Reply' }).click()
  const composer = page.locator('[data-slot="composer-reply"]')
  await expect(composer).toContainText('2 attachments')
  await expect(composer.locator(`${thumbnail} img`)).toHaveAttribute(
    'alt',
    'first.png',
  )
  await page.locator('[data-slot="editor"]').fill('Thanks for the files')
  await page.getByRole('button', { name: 'Send', exact: true }).click()

  const quote = page
    .locator('[data-slot="reply-quote"]')
    .filter({ hasText: '2 attachments' })
  await expect(quote).toBeVisible()
  await expect(quote.locator(`${thumbnail} img`)).toHaveAttribute(
    'alt',
    'first.png',
  )
  await expect(
    page.getByText('Thanks for the files', { exact: true }),
  ).toBeVisible()
  await quote.click()
  await expect(page.locator('[data-slot="message-highlight"]')).toBeVisible()
  await expect(first).toBeInViewport()
})

test('a text-block reply shows the first file when the original is outside the loaded window', async ({
  page,
}) => {
  await page.goto(`${fixture}&unloadedReplyTarget`)
  await page.getByText('Keep this caption').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Reply' }).click()

  const composer = page.locator('[data-slot="composer-reply"]')
  await expect(composer).toContainText('Keep this caption')
  await expect(composer.locator(`${thumbnail} img`)).toHaveAttribute(
    'alt',
    'first.png',
  )
  await page.locator('[data-slot="editor"]').fill('Reply to caption')
  await page.getByRole('button', { name: 'Send', exact: true }).click()

  const quote = page.locator('[data-slot="reply-quote"]')
  await expect(quote).toContainText('Keep this caption')
  await expect(page.locator('[data-message-id="file-message"]')).toHaveCount(0)
  await expect(quote.locator(`${thumbnail} img`)).toHaveAttribute(
    'alt',
    'first.png',
  )
})

for (const filename of ['first.png', 'second.png']) {
  test(`deletes only ${filename} after confirmation`, async ({ page }) => {
    await page.goto(fixture)
    const selected = page.getByRole('img', { name: filename })
    const sibling = page.getByRole('img', {
      name: filename === 'first.png' ? 'second.png' : 'first.png',
    })
    const deleteMenu = page.getByRole('menuitem', {
      name: 'Delete',
      exact: true,
    })
    const deleteAttachment = page.getByRole('menuitem', {
      name: 'Delete Attachment',
    })
    const dialog = page.getByRole('alertdialog')

    await selected.click({ button: 'right' })
    await deleteMenu.hover()
    await expect(
      page.getByRole('menuitem', { name: 'Delete Message' }),
    ).toBeVisible()
    await deleteAttachment.click()
    await expect(dialog).toContainText('Delete attachment?')
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(selected).toBeVisible()
    await expect(sibling).toBeVisible()

    await selected.click({ button: 'right' })
    await deleteMenu.hover()
    await deleteAttachment.click()
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(selected).toHaveCount(0)
    await expect(sibling).toBeVisible()
    await expect(page.getByText('Keep this caption')).toBeVisible()
  })
}

test('uses the attachment action for a sole file, even without a download URL', async ({
  page,
}) => {
  await page.goto(fixture)
  const row = page.locator(singleRow)
  const preview = row.locator('[data-attachment-name="archive.pdf"]')
  const menu = page.getByRole('menu')

  await row.click({ button: 'right', position: { x: 350, y: 48 } })
  await expect(menu.getByRole('menuitem')).toHaveText([
    'Reply',
    'Delete Message',
  ])
  await preview.click({ button: 'right' })
  await menu.getByRole('menuitem', { name: 'Reply' }).click()
  const composer = page.locator('[data-slot="composer-reply"]')
  await expect(composer).toContainText('1 attachment')
  await expect(composer.getByRole('img', { name: 'archive.pdf' })).toBeVisible()
  await composer.getByRole('button', { name: 'Cancel reply' }).click()

  const deleteMenu = page.getByRole('menuitem', { name: 'Delete', exact: true })
  const dialog = page.getByRole('alertdialog')
  await preview.click({ button: 'right' })
  await deleteMenu.hover()
  await page.getByRole('menuitem', { name: 'Delete Message' }).click()
  await expect(dialog).toContainText('Delete this message?')
  await dialog.getByRole('button', { name: 'Cancel' }).click()

  await preview.click({ button: 'right' })
  await deleteMenu.hover()
  await page.getByRole('menuitem', { name: 'Delete Attachment' }).click()
  await expect(dialog).toContainText('Delete attachment?')
  await expect(dialog).toContainText(
    'Deleting it will also delete the message.',
  )
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(
    page.locator('[data-message-id="single-attachment"]'),
  ).toHaveCount(0)
})
