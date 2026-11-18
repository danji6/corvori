import { expect, test } from '@playwright/test'
import type { Editor } from '@tiptap/core'

test('Backspace removes an empty paragraph after a prompt list', async ({
  page,
}) => {
  await page.goto('/?fixture=provider-connections')
  await page.getByRole('button', { name: 'Change prompt' }).click()
  const dialog = page.getByRole('dialog', { name: 'Title prompt', exact: true })
  const editor = dialog.getByRole('textbox')
  await editor.evaluate((element: HTMLElement & { editor?: Editor }) => {
    const current = element.editor!
    current.commands.setContent({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Rules:' }] },
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: 'Rule' }],
                },
              ],
            },
          ],
        },
        { type: 'paragraph' },
        { type: 'paragraph', content: [{ type: 'text', text: 'Request' }] },
      ],
    })
  })

  await editor.press('ControlOrMeta+End')
  await editor.press('Home')
  await editor.press('Backspace')
  await expect(editor.locator(':scope > p')).toHaveText(['Rules:', 'Request'])
})
