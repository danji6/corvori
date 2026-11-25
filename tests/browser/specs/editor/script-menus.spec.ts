import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.goto('/?fixture=script-menus')
  await expect(page.getByTestId('message')).toBeVisible()
})

for (const readOnly of [false, true]) {
  test(`the message context menu omits Scripts (read only: ${readOnly})`, async ({
    page,
  }) => {
    if (readOnly) await page.getByLabel('Read only').check()
    await page.getByTestId('message').click({ button: 'right' })
    await expect(
      page.getByRole('menuitem', { name: 'Copy Message', exact: true }),
    ).toBeVisible()
    await expect(page.getByRole('menu').getByRole('separator')).toHaveCount(
      readOnly ? 0 : 1,
    )
    await expect(
      page.getByRole('menuitem', { name: 'Scripts', exact: true }),
    ).toHaveCount(0)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(
      page.getByLabel('Editing message', { exact: true }),
    ).toHaveText('none')
    await expect(page.getByLabel('Script actions', { exact: true })).toHaveText(
      '0',
    )
    expect(new URL(page.url()).searchParams.has('view')).toBe(false)
  })
}

for (const role of ['user', 'assistant'] as const) {
  test(`separates the visible action groups for an attachment-only ${role} message`, async ({
    page,
  }) => {
    await page.goto(`/?fixture=script-menus&attachmentOnly=${role}`)
    await page.getByTestId('message').click({ button: 'right' })

    const menu = page.getByRole('menu')
    const hasRetry = role === 'assistant'
    await expect(menu.getByRole('menuitem')).toHaveText(
      hasRetry ? ['Retry', 'Delete Message'] : ['Delete Message'],
    )
    await expect(menu.getByRole('separator')).toHaveCount(hasRetry ? 1 : 0)
  })
}

test('the built-in bubble toolbar has formatting actions and no Delete action', async ({
  page,
}) => {
  await expect(
    page.getByRole('button', { name: 'Clear formatting', exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Bold', exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Delete', exact: true }),
  ).toHaveCount(0)
})

test('the context menu remains disabled for a message being edited', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Start editing', exact: true }).click()
  await expect(page.getByLabel('Editing message', { exact: true })).toHaveText(
    'fixture',
  )
  await page.getByTestId('message').click({ button: 'right' })
  await expect(page.getByRole('menu')).toHaveCount(0)
})

test('copies the link under the latest right-click, including through the open menu', async ({
  page,
}) => {
  const firstUrl = 'https://example.test/first'
  const secondUrl = 'https://example.test/second'
  const message = `[**First link**](${firstUrl})\n\n[**Second link**](${secondUrl})\n\nPlain text`
  await page.addInitScript(() => {
    let clipboard = ''
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: async (value: string) => {
          clipboard = value
        },
        readText: async () => clipboard,
      },
    })
  })
  await page.goto(
    `/?fixture=script-menus&message=${encodeURIComponent(message)}`,
  )
  await page.getByLabel('Read only').check()
  const first = page.getByRole('link', { name: 'First link' }).locator('strong')
  const second = page
    .getByRole('link', { name: 'Second link' })
    .locator('strong')
  const copyLink = page.getByRole('menuitem', {
    name: 'Copy Link',
    exact: true,
  })
  const menu = page.getByRole('menu')

  await first.click({ button: 'right', position: { x: 2, y: 8 } })
  await expect(copyLink).toBeVisible()
  const secondBounds = (await second.boundingBox())!
  const x = Math.ceil(secondBounds.x) + 8
  const y = Math.ceil(secondBounds.y) + 8
  await expect
    .poll(() =>
      menu.evaluate(
        (popup, point) =>
          popup.contains(document.elementFromPoint(point.x, point.y)),
        { x, y },
      ),
    )
    .toBe(true)
  await page.mouse.click(x, y, { button: 'right' })
  await expect(menu).toHaveCSS('top', `${y}px`)
  await expect(menu.getByRole('menuitem', { name: 'Download' })).toHaveCount(0)
  await copyLink.click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    secondUrl,
  )

  await first.click({ button: 'right' })
  await expect(copyLink).toBeVisible()
  const plain = page.getByText('Plain text', { exact: true })
  const plainBounds = (await plain.boundingBox())!
  await page.mouse.click(plainBounds.x + 8, plainBounds.y + 8, {
    button: 'right',
  })
  await expect(copyLink).toHaveCount(0)
  await expect(
    menu.getByRole('menuitem', { name: 'Copy Message' }),
  ).toBeVisible()
})

test('pasting external text into a message keeps its editable blank lines on save', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Start editing', exact: true }).click()
  const editor = page.getByTestId('message').locator('.ProseMirror')
  await expect(editor).toBeFocused()
  await editor.press('ControlOrMeta+a')
  const source =
    'First line\ncontinued\n\nSecond paragraph\n\n\n\nThird paragraph'
  await editor.evaluate((element, text) => {
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', text.replaceAll('\n', '\r\n'))
    element.dispatchEvent(
      new ClipboardEvent('paste', {
        clipboardData,
        bubbles: true,
        cancelable: true,
      }),
    )
  }, source)

  await expect(editor.locator('br')).toHaveCount(7)
  await editor.press('ControlOrMeta+s')
  const saved = page.getByLabel('Saved message markdown')
  await expect.poll(() => saved.textContent()).toBe(source)
})
