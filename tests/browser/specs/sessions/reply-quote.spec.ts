import { type Page, expect, test } from '@playwright/test'

test('reply quotes jump to their exact text block across loaded windows', async ({
  page,
}) => {
  await page.goto('/?fixture=message-pagination&replies')
  await expect(page.locator('main')).toHaveAttribute(
    'data-position-ready',
    'true',
  )
  await page.clock.install()

  const highlight = page.locator('[data-slot="message-highlight"]')
  for (const segmentIndex of [4, 1, 4]) {
    await page
      .locator('[data-slot="reply-quote"]')
      .filter({
        hasText: `Quoted text in segment ${segmentIndex}`,
      })
      .click()

    const block = page.locator('article').filter({
      hasText: `Quoted text in segment ${segmentIndex}`,
    })
    await expect(block).toBeVisible()
    await expect
      .poll(() =>
        block.evaluate((element) =>
          Math.round(
            element.closest('[data-row-key]')!.getBoundingClientRect().top,
          ),
        ),
      )
      .toBe(64)
    await expect(highlight).toBeVisible()
    // After the jump, wait for the virtualized transcript to receive clicks again.
    await expect
      .poll(() =>
        block.evaluate((element) => {
          const { x, y, width, height } = element.getBoundingClientRect()
          return element.contains(
            document.elementFromPoint(x + width / 2, y + height / 2),
          )
        }),
      )
      .toBe(true)
    await block.click()
  }

  await page.clock.runFor(2000)
  await expect(highlight).toBeVisible()

  const lastBlock = page
    .locator('article')
    .filter({ hasText: 'Quoted text in segment 4' })
  const scrollDeltas = await lastBlock.evaluate((block) => {
    const overlay = document.querySelector('[data-slot="message-highlight"]')!
    const blockTop = block.getBoundingClientRect().top
    const overlayTop = overlay.getBoundingClientRect().top

    window.scrollBy({ top: 48, behavior: 'instant' })

    return {
      block: block.getBoundingClientRect().top - blockTop,
      highlight: overlay.getBoundingClientRect().top - overlayTop,
    }
  })
  expect(scrollDeltas).toEqual({ block: -48, highlight: -48 })
})

const editFixture = '/?fixture=notes&id=notes&replyQuoteEditing'

function replyQuoteRow(page: Page) {
  return page.locator('[data-row-kind="reply"][data-message-id="reply"]')
}

async function editMessage(page: Page, id: 'answer' | 'reply') {
  const content = page.locator(
    `[data-row-kind="group"][data-message-id="${id}"]`,
  )
  await content.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Edit Message' }).click()
  return content.locator('[data-slot="editor"]')
}

test('disables Reply while another message is being edited', async ({
  page,
}) => {
  await page.goto(editFixture)
  const answer = page.locator(
    '[data-row-kind="group"][data-message-id="answer"]',
  )
  const reply = page.getByRole('menuitem', { name: 'Reply', exact: true })

  await editMessage(page, 'reply')
  await answer.click({ button: 'right' })
  await expect(reply).toBeDisabled()

  await page.getByRole('button', { name: 'Cancel edit' }).click()
  await answer.click({ button: 'right' })
  await expect(reply).toBeEnabled()
})

test('removes a reply quote in the draft and restores it on Escape or Cancel', async ({
  page,
}) => {
  await page.goto(editFixture)
  const quote = replyQuoteRow(page)
  const remove = quote.getByRole('button', { name: 'Remove reply quote' })
  await expect(quote).toContainText('Content for answer')
  await expect(remove).toHaveCount(0)

  const editor = await editMessage(page, 'reply')
  await expect(editor).toBeVisible()
  await remove.focus()
  await remove.press('Enter')
  await expect(quote).toHaveCount(0)
  await expect(editor).toBeFocused()
  await expect(page.locator('[data-slot="message-highlight"]')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(quote).toContainText('Content for answer')
  await expect(remove).toHaveCount(0)

  await editMessage(page, 'reply')
  await remove.click()
  await expect(quote).toHaveCount(0)
  await page.getByRole('button', { name: 'Cancel edit' }).click()
  await expect(quote).toBeVisible()
})

test('saves quote removal from the toolbar and when switching edits', async ({
  page,
}) => {
  await page.goto(editFixture)
  const quote = replyQuoteRow(page)
  const remove = quote.getByRole('button', { name: 'Remove reply quote' })
  const cancel = page.getByRole('button', { name: 'Cancel edit' })

  await editMessage(page, 'reply')
  await remove.click()
  const answerEditor = await editMessage(page, 'answer')
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: 'Discard' })
    .click()
  await expect(answerEditor).toBeVisible()
  await expect(quote).toBeVisible()
  await expect(remove).toHaveCount(0)
  await cancel.click()

  await editMessage(page, 'reply')
  await remove.click()
  await editMessage(page, 'answer')
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: 'Save' })
    .click()
  await expect(answerEditor).toBeVisible()
  await expect(quote).toHaveCount(0)
  await expect(
    page.getByText('Content for reply', { exact: true }),
  ).toBeVisible()

  await page.reload()
  const replyEditor = await editMessage(page, 'reply')
  await replyEditor.fill('Edited reply')
  await remove.click()
  await page.getByRole('button', { name: 'Save edit' }).click()
  await expect(quote).toHaveCount(0)
  await expect(page.getByText('Edited reply', { exact: true })).toBeVisible()
})

test('restores the reply quote and reports a rejected save', async ({
  page,
}) => {
  await page.goto(`${editFixture}&rejectQuoteRemoval`)
  const quote = replyQuoteRow(page)
  await editMessage(page, 'reply')
  await quote.getByRole('button', { name: 'Remove reply quote' }).click()
  await expect(quote).toHaveCount(0)
  await page.getByRole('button', { name: 'Save edit' }).click()
  await expect(quote).toContainText('Content for answer')
  await expect(page.getByText('Quote removal rejected')).toBeVisible()
})
