import { type Page, expect, test } from '@playwright/test'

async function mockClipboard(page: Page) {
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
}

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

test('the editor menu runs scripts on the selection and opens the script manager', async ({
  page,
}) => {
  await page.goto('/?fixture=script-menus&withScripts')
  await page.getByRole('button', { name: 'Start editing', exact: true }).click()
  const editor = page.getByTestId('message').locator('.ProseMirror')
  const menu = page.getByRole('menu')
  await expect(editor).toBeFocused()
  await editor.click({ button: 'right', modifiers: ['Shift'] })
  await expect(menu).toHaveCount(0)
  await editor.press('ArrowLeft')
  await editor.click({ button: 'right' })
  await expect(menu.getByRole('menuitem')).toHaveText([
    'Scripts',
    'Run Script…',
    'Cut',
    'Copy',
    'Paste',
    'Select all',
  ])
  await expect(menu.getByRole('separator')).toHaveCount(1)
  await expect(menu.getByRole('menuitem', { name: 'Cut' })).toBeDisabled()
  await editor.press('Escape')
  await expect(menu).toHaveCount(0)
  await editor.click({ button: 'right' })
  await menu.getByRole('menuitem', { name: 'Select all' }).click()
  await editor.click({ button: 'right' })
  await menu.getByRole('menuitem', { name: 'Run Script…' }).hover()
  const submenu = menu.getByRole('menu')
  await expect(
    submenu.getByRole('menuitem', { name: 'Replace message' }),
  ).toBeVisible()
  await submenu.getByRole('menuitem', { name: 'Uppercase selection' }).click()
  await expect(editor).toHaveText('FIXTURE TEXT')

  await editor.click({ button: 'right' })
  await menu.getByRole('menuitem', { name: 'Scripts', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.getByLabel('Editing message', { exact: true })).toHaveText(
    'fixture',
  )
})

test('copies the link under the latest right-click, including through the open menu', async ({
  page,
}) => {
  const firstUrl = 'https://example.test/first'
  const secondUrl = 'https://example.test/second'
  const message = `[**First link**](${firstUrl})\n\n[**Second link**](${secondUrl})\n\nPlain text`
  await mockClipboard(page)
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

test('copies the browser selection inside and outside the message', async ({
  page,
}) => {
  await mockClipboard(page)
  await page.goto('/?fixture=script-menus&message=Fixture%20**text**%20here')
  await page.getByLabel('Read only').check()

  const message = page.getByTestId('message')
  const bold = message.locator('strong')
  const copySelection = page.getByRole('menuitem', { name: 'Copy Selection' })
  const copyMessage = page.getByRole('menuitem', { name: 'Copy Message' })
  const openMenu = () =>
    message.click({ button: 'right', position: { x: 8, y: 8 } })
  const readClipboard = () =>
    page.evaluate(() => navigator.clipboard.readText())

  await bold.evaluate((element) => {
    const start = element.previousSibling!
    const end = element.firstChild!
    document.getSelection()!.setBaseAndExtent(start, 3, end, 4)
  })
  await bold.click({ button: 'right' })
  await expect(copySelection).toBeVisible()
  await expect(copyMessage).toHaveCount(0)
  await openMenu()
  await copySelection.click({ button: 'right' })
  await copySelection.click()
  expect(await readClipboard()).toBe('ture text')

  const editButton = page.getByRole('button', { name: 'Start editing' })
  await editButton.evaluate((button) => {
    document.getSelection()!.selectAllChildren(button)
  })
  await openMenu()
  await copySelection.click()
  expect(await readClipboard()).toBe('Start editing')

  const spanningText = await editButton.evaluate((button) => {
    const start = document.querySelector('[data-testid="message"] strong')!
    const selection = document.getSelection()!
    selection.setBaseAndExtent(start.firstChild!, 0, button.firstChild!, 5)
    return selection.toString()
  })
  expect(spanningText).toMatch(/^text here\s+Start$/)
  await openMenu()
  await copySelection.click()
  expect(await readClipboard()).toBe(spanningText)
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

test('Paste reads the clipboard through the existing multiline paste handler', async ({
  page,
}) => {
  const source = 'First line\ncontinued\n\nSecond paragraph'
  await page.addInitScript((text) => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { readText: async () => text },
    })
  }, source)
  await page.reload()
  await page.getByRole('button', { name: 'Start editing', exact: true }).click()
  const editor = page.getByTestId('message').locator('.ProseMirror')
  await expect(editor).toBeFocused()
  await editor.press('ControlOrMeta+a')
  await editor.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Paste', exact: true }).click()
  await expect(editor.locator('br')).toHaveCount(3)
  await editor.press('ControlOrMeta+s')
  await expect
    .poll(() => page.getByLabel('Saved message markdown').textContent())
    .toBe(source)
})

test('plain HTTP uses clipboard commands and keeps the text when Cut fails', async ({
  page,
}) => {
  await page.route('http://clipboard.test/**', async (route) => {
    const url = new URL(route.request().url())
    const response = await route.fetch({
      url: `http://127.0.0.1:4178${url.pathname}${url.search}`,
    })
    await route.fulfill({ response })
  })
  await page.addInitScript(() => {
    const execute = document.execCommand.bind(document)
    document.execCommand = (command) => {
      const state = document.body.dataset
      state.clipboardCommand = command
      if (command === 'paste' || state.rejectCopy) return false
      document.activeElement?.addEventListener(
        'copy',
        (event) => {
          state.copied = (event as ClipboardEvent).clipboardData?.getData(
            'text/plain',
          )
        },
        { once: true },
      )
      return execute(command)
    }
  })
  await page.goto('http://clipboard.test/?fixture=script-menus')
  expect(
    await page.evaluate(() => [isSecureContext, !!navigator.clipboard]),
  ).toEqual([false, false])

  const message = page.getByTestId('message')
  const body = page.locator('body')
  await message.click({ button: 'right' })
  await page
    .getByRole('menuitem', { name: 'Copy Message', exact: true })
    .click()
  await expect(body).toHaveAttribute('data-copied', 'Fixture text')

  await page.getByRole('button', { name: 'Start editing', exact: true }).click()
  const editor = message.locator('.ProseMirror')
  await expect(editor).toBeFocused()
  await editor.press('ControlOrMeta+a')
  await body.evaluate((el) => {
    el.dataset.rejectCopy = 'true'
  })
  await editor.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Cut', exact: true }).click()
  await expect(
    page.getByText('Could not copy to the clipboard', { exact: true }),
  ).toBeVisible()
  await expect(editor).toHaveText('Fixture text')

  await body.evaluate((el) => {
    delete el.dataset.rejectCopy
    delete el.dataset.copied
  })
  await editor.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Cut', exact: true }).click()
  await expect(body).toHaveAttribute('data-copied', 'Fixture text')
  await expect(editor).toHaveText('')

  await editor.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Paste', exact: true }).click()
  await expect(body).toHaveAttribute('data-clipboard-command', 'paste')
  await expect(
    page.getByText('Press Ctrl+V or ⌘V to paste', { exact: true }),
  ).toBeVisible()
  await expect(editor).toBeFocused()
})
