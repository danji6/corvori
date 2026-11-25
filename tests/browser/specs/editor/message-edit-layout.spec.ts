import type { Locator } from '@playwright/test'
import { expect, test } from '@playwright/test'

const lines = [
  'Before the table',
  'After the table',
  'Next paragraph',
  'Soft break',
]
const markdown = [
  lines[0],
  '| Name | Value |\n| --- | --- |\n| Sample | Example |',
  `**${lines[1]}**`,
  `${lines[2]}\n${lines[3]}`,
].join('\n\n')

async function measureLayout(message: Locator) {
  return message.evaluate(async (block, lines) => {
    await document.fonts.ready
    const origin = block.getBoundingClientRect().top
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
    const tops: number[] = []

    for (const line of lines) {
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const start = node.textContent?.indexOf(line) ?? -1
        if (start < 0) continue
        const range = document.createRange()
        range.setStart(node, start)
        range.setEnd(node, start + line.length)
        tops.push(range.getBoundingClientRect().top - origin)
        break
      }
    }

    const table = block.querySelector('table')!.getBoundingClientRect()
    return { tops, tableTop: table.top - origin, tableHeight: table.height }
  }, lines)
}

test('message edit mode matches the viewed paragraph and table spacing', async ({
  page,
}) => {
  await page.goto(
    `/?fixture=script-menus&message=${encodeURIComponent(markdown)}`,
  )
  const message = page.locator('[data-slot="text-block"]')
  await expect(message.locator('table')).toBeVisible()
  const viewed = await measureLayout(message)
  expect(viewed.tops).toHaveLength(lines.length)

  await page.getByRole('button', { name: 'Start editing' }).click()
  await expect(message.locator('.ProseMirror')).toBeFocused()
  const edited = await measureLayout(message)

  expect(edited.tops).toHaveLength(lines.length)
  for (const [index, top] of viewed.tops.entries()) {
    expect(edited.tops[index]).toBeCloseTo(top, 0)
  }
  expect(edited.tableTop).toBeCloseTo(viewed.tableTop, 0)
  expect(edited.tableHeight).toBeCloseTo(viewed.tableHeight, 0)
})

test('the caret can still type on the blank line between paragraphs', async ({
  page,
}) => {
  await page.goto('/?fixture=script-menus&message=First%0A%0ASecond')
  await page.getByRole('button', { name: 'Start editing' }).click()
  const editor = page.locator('[data-slot="text-block"] .ProseMirror')
  await expect(editor).toBeFocused()

  const blankLine = await editor
    .locator('br')
    .nth(1)
    .evaluate((line) => {
      const { x, y, height } = line.getBoundingClientRect()
      return { x, y: y + height / 2 }
    })
  await page.mouse.click(blankLine.x + 2, blankLine.y)
  await page.keyboard.insertText('Inserted')
  await editor.press('ControlOrMeta+s')

  const saved = page.getByLabel('Saved message markdown')
  await expect.poll(() => saved.textContent()).toBe('First\nInserted\nSecond')
})

test('preserves the caret and selection when scrolling away from an edited message', async ({
  page,
}) => {
  await page.goto('/?fixture=notes&id=notes&editHistory&intoView')
  const latest = page.getByText('Content for history31', { exact: true })
  await expect(latest).toBeInViewport()
  const column = page.locator('.chat-transcript-column')
  await expect(column.locator('..')).toHaveCSS('opacity', '1')
  await page.keyboard.press('Alt+Home')

  const message = page.locator(
    '[data-row-kind="group"][data-message-id="history2"]',
  )
  const text = 'Content for history2'
  const line = message.getByText(text, { exact: true })
  await expect(line).toBeInViewport()
  await line.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Edit Message' }).click()
  const editor = message.locator('[data-slot="editor"]')
  await expect(editor).toBeFocused()
  await page.evaluate(() => window.scrollBy(0, 50))

  const editedLine = editor.getByText(text, { exact: true })
  const select = (focusOffset: number) =>
    editedLine.evaluate((line, offset) => {
      const node = line.firstChild!
      document.getSelection()!.setBaseAndExtent(node, 2, node, offset)
    }, focusOffset)
  const selection = () =>
    editor.evaluate(() => {
      const current = document.getSelection()!
      return {
        anchor: current.anchorNode?.textContent,
        anchorOffset: current.anchorOffset,
        focus: current.focusNode?.textContent,
        focusOffset: current.focusOffset,
      }
    })

  for (const focusOffset of [2, 8]) {
    await select(focusOffset)
    const before = await page.evaluate(() => window.scrollY)
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await expect(latest).toBeInViewport()
    await expect(editor).toHaveCount(1)
    await expect(editor).not.toBeInViewport()

    await page.evaluate((scrollY) => window.scrollTo(0, scrollY), before)
    await expect(editedLine).toBeInViewport()
    await expect(editor).toBeFocused()
    expect(await selection()).toEqual({
      anchor: text,
      anchorOffset: 2,
      focus: text,
      focusOffset,
    })
    expect(await page.evaluate(() => window.scrollY)).toBeCloseTo(before, 0)
  }

  await page.getByRole('button', { name: 'Cancel edit' }).click()
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
  await expect(latest).toBeInViewport()
  await expect(message).toHaveCount(0)
})

test('messages show editable link destinations and disable navigation during editing', async ({
  page,
}) => {
  const source =
    'See [Museum](https://example.com/old) and <a href="https://example.com/html">HTML link</a>.'
  await page.goto(
    `/?fixture=script-menus&message=${encodeURIComponent(source)}`,
  )
  const message = page.locator('[data-slot="text-block"]')
  await expect(message.getByRole('link', { name: 'Museum' })).toHaveAttribute(
    'href',
    'https://example.com/old',
  )

  await page.getByRole('button', { name: 'Start editing' }).click()
  const editor = message.locator('.ProseMirror')
  await expect(editor).toBeFocused()
  await expect(
    editor.getByText('](https://example.com/old)', { exact: true }),
  ).toBeVisible()
  await expect(editor.getByRole('link', { name: 'Museum' })).toHaveCount(0)

  const htmlLink = editor.getByRole('link', { name: 'HTML link' })
  expect(
    await htmlLink.evaluate((link) =>
      link.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      ),
    ),
  ).toBe(false)
})
