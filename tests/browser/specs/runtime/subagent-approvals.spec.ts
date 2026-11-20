import { type Page, expect, test } from '@playwright/test'

const picker = (page: Page) =>
  page.locator('[data-slot="tool-approval-picker"]')
const note = (page: Page) => picker(page).locator('[contenteditable="true"]')
const composer = (page: Page) =>
  page.locator('[data-slot="chat-box"] [contenteditable="true"]')
const review = (page: Page) =>
  page.getByRole('button', { name: 'Review approval', exact: true })
const actions = (page: Page) =>
  picker(page).getByRole('group', { name: 'Approval actions' })

async function releaseApprovals(page: Page) {
  await page.evaluate(() =>
    window.dispatchEvent(new Event('release-approvals')),
  )
}

async function mutations(page: Page) {
  const calls = JSON.parse(
    (await page.getByTestId('approval-mutations').textContent()) ?? '[]',
  ) as {
    name: string
    args: Record<string, unknown>
  }[]
  return calls.filter(({ name }) => !name.startsWith('typing:'))
}

async function resolveApproval(page: Page) {
  await page
    .getByRole('button', { name: 'Resolve approval', exact: true })
    .click()
}

test('updates unrestricted access in an existing chat without a workspace', async ({
  page,
}) => {
  await page.goto('/?fixture=subagent-approvals&id=parent&delayedApprovals')
  const ask = page.getByRole('button', { name: /allow unrestricted access/ })
  const unrestricted = page.getByRole('button', { name: /require approvals/ })
  await ask.click()
  await expect(unrestricted).toHaveAttribute('aria-pressed', 'true')
  await unrestricted.click()
  await expect(ask).toHaveAttribute('aria-pressed', 'false')
  expect(await mutations(page)).toEqual([
    {
      name: 'sessions:setApprovalMode',
      args: { sessionId: 'parent', mode: 'unrestricted' },
    },
    {
      name: 'sessions:setApprovalMode',
      args: { sessionId: 'parent', mode: 'ask' },
    },
  ])

  await page.goto('/?fixture=subagent-approvals&id=parent&nonAdmin')
  await expect(ask).toHaveCount(0)
})

test('approves locally with a note and keeps the parent queue synchronized', async ({
  page,
}) => {
  await page.goto('/?fixture=subagent-approvals&id=child')
  await expect(picker(page)).toBeVisible()
  await expect(picker(page)).toContainText('git push origin first')
  await expect(
    page.getByRole('status', { name: 'Explore is waiting' }),
  ).toBeVisible()
  await expect(picker(page)).not.toContainText('git push origin sibling')
  await expect(page.locator('[data-slot="subagent-banner"]')).toBeVisible()
  await note(page).fill('Use the test remote')
  await note(page).press('ControlOrMeta+Enter')
  await expect(picker(page)).toContainText('git push origin second')
  await expect(note(page)).toHaveText('')
  expect((await mutations(page))[0]).toEqual({
    name: 'chat:approveTool',
    args: {
      sessionId: 'parent',
      childSessionId: 'child',
      toolCallId: 'first',
      approved: true,
      note: 'Use the test remote',
    },
  })
  await resolveApproval(page)
  await page.getByRole('button', { name: 'View parent', exact: true }).click()
  await expect(picker(page)).toContainText('Sub-agent: Explore')
  await expect(picker(page)).toContainText('git push origin second')
  await picker(page).getByRole('option', { name: /^Deny/ }).click()
  await expect(picker(page)).toContainText('git push origin sibling')
  await resolveApproval(page)
  await page.getByRole('button', { name: 'View child', exact: true }).click()
  await expect(picker(page)).toHaveCount(0)
  await expect(
    page.getByRole('status', { name: 'Explore is working' }),
  ).toBeVisible()
  expect((await mutations(page))[1].args).toMatchObject({
    sessionId: 'parent',
    childSessionId: 'child',
    toolCallId: 'second',
    approved: false,
  })
})

test('opens approval when the empty composer is focused', async ({ page }) => {
  await page.goto('/?fixture=subagent-approvals&id=parent&delayedApprovals')
  const editor = composer(page)
  await editor.focus()
  await expect(editor).toBeFocused()
  await expect(editor).toHaveText('')

  await releaseApprovals(page)
  await expect(picker(page)).toBeVisible()
  const options = actions(page)
  await expect(options).toBeFocused()
  await expect(review(page)).toHaveCount(0)
})

test('navigates question choices and context with the keyboard', async ({
  page,
}) => {
  await page.goto('/?fixture=subagent-approvals&id=parent&question')
  const options = page.getByRole('radiogroup', { name: 'Which option?' })
  await expect(options).toBeFocused()

  await page.keyboard.press('ArrowDown')
  await expect(options.getByRole('radio', { name: '1 A' })).toBeChecked()

  await page.keyboard.press('Tab')
  await expect(page.getByRole('textbox', { name: 'Additional context' })).toBeFocused() // prettier-ignore
  await page.keyboard.press('Shift+Tab')
  await expect(options).toBeFocused()
})

test('keeps an automatic approval stable while work expands and collapses', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 700 })
  await page.goto(
    '/?fixture=subagent-approvals&id=parent&localApproval&history',
  )
  await expect(picker(page)).toBeVisible()
  const summary = page.locator('[data-slot="work-block"]')
  await expect(summary).toBeInViewport({ ratio: 1 })
  // Make the work details taller than the dock's unstick threshold.
  await page.addStyleTag({
    content:
      '[data-work-id] > [data-slot="virtualized-row-transition"] > div > * { min-height: 220px }',
  })

  const transitions = page.locator(
    '[data-work-id] [data-slot="virtualized-row-transition"][data-state]',
  )
  const originalPicker = await picker(page).elementHandle()
  await summary.evaluate((button) => (button as HTMLButtonElement).click())
  await expect(transitions.first()).toBeAttached()
  await expect(transitions).toHaveCount(0)
  await expect(summary).toHaveAttribute('aria-expanded', 'true')
  expect(await originalPicker.evaluate((element) => element.isConnected)).toBe(
    true,
  )

  await summary.evaluate((button) => (button as HTMLButtonElement).click())
  await expect(transitions).toHaveCount(0)
  await expect(summary).toHaveAttribute('aria-expanded', 'false')
  expect(await originalPicker.evaluate((element) => element.isConnected)).toBe(
    true,
  )
})

test('restores note drafts and approval navigation when moving between views', async ({
  page,
}) => {
  await page.goto('/?fixture=subagent-approvals&id=child')
  await note(page).fill('Shared child note')
  await page.getByRole('button', { name: 'View parent', exact: true }).click()
  await expect(note(page)).toHaveText('Shared child note')
  await page.getByRole('button', { name: 'View child', exact: true }).click()
  await expect(note(page)).toHaveText('Shared child note')
  const options = actions(page)
  await expect(options).toBeFocused()
  const deny = picker(page).getByRole('option', { name: /^Deny/ })
  const abort = picker(page).getByRole('option', { name: /^Abort/ })
  await deny.hover()
  await expect(deny).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('ArrowDown')
  await expect(abort).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('ArrowUp')
  await expect(deny).toHaveAttribute('aria-selected', 'true')

  await page.keyboard.press('Tab')
  await expect(note(page)).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(options).toBeFocused()
  await expect(deny).toHaveAttribute('aria-selected', 'true')
  expect(await mutations(page)).toEqual([])
})

test('remembers a local approval through the shared parent policy', async ({
  page,
}) => {
  await page.goto('/?fixture=subagent-approvals&id=child')
  await picker(page)
    .getByRole('option', { name: /for this session/ })
    .click()
  await expect(picker(page)).toContainText('git push origin second')
  expect((await mutations(page))[0].args).toMatchObject({
    sessionId: 'parent',
    childSessionId: 'child',
    toolCallId: 'first',
    approved: true,
    remember: 'patterns',
  })
  await resolveApproval(page)
})

test('aborts only the viewed child', async ({ page }) => {
  await page.goto('/?fixture=subagent-approvals&id=child')
  await picker(page)
    .getByRole('option', { name: /^Abort/ })
    .click()
  await expect(picker(page)).toHaveCount(0)
  await expect(page.locator('[data-slot="activity-indicator"]')).toHaveCount(0)
  expect((await mutations(page))[0]).toEqual({
    name: 'chat:stopStream',
    args: { sessionId: 'child', execution: { streamId: 'child_stream' } },
  })
  await page.getByRole('button', { name: 'View parent', exact: true }).click()
  await expect(picker(page)).toContainText('git push origin sibling')
})

test('combines busy typing activity with agent status in the same indicator', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/?fixture=subagent-approvals&id=child&typing=5')
  const activity = page.locator('[data-slot="activity-indicator"]')
  await expect(activity).toHaveText('5 people are typing·Explore is waiting')
  await expect(activity).toHaveAttribute(
    'title',
    'Alice, Bob, Carol, Dave, Eve are typing · Explore is waiting',
  )
  await page.getByRole('button', { name: 'Stop typing', exact: true }).click()
  await expect(activity).toHaveText('Explore is waiting')
  await expect(page.locator('[data-slot="waiting-indicator"]')).toHaveCount(0)
})

test('restores the request and note after an approval fails', async ({
  page,
}) => {
  await page.goto('/?fixture=subagent-approvals&id=child')
  await page
    .getByRole('button', { name: 'Fail next approval', exact: true })
    .click()
  await note(page).fill('Retain this note')
  await note(page).press('ControlOrMeta+Enter')
  await expect(picker(page)).toContainText('git push origin second')
  await resolveApproval(page)
  await expect(picker(page)).toContainText('git push origin first')
  await expect(note(page)).toHaveText('Retain this note')
})

test('a failed decision stays deferred when the composer is active again', async ({
  page,
}) => {
  await page.goto('/?fixture=subagent-approvals&id=parent&delayedApprovals')
  const editor = composer(page)
  await editor.fill('Keep drafting')
  await releaseApprovals(page)
  await review(page).click()
  await page
    .getByRole('button', { name: 'Fail next approval', exact: true })
    .click()
  await note(page).fill('Retry this note')
  await note(page).press('ControlOrMeta+Enter')
  await expect(editor).toBeFocused()
  await resolveApproval(page)
  await expect(page.getByText('Fixture approval failure')).toBeVisible()
  await expect(picker(page)).toHaveCount(0)
  await expect(editor).toHaveText('Keep drafting')

  await review(page).click()
  await expect(picker(page)).toContainText('git push origin first')
  await expect(note(page)).toHaveText('Retry this note')
})

test('keeps approval controls unavailable to non-admins', async ({ page }) => {
  await page.goto('/?fixture=subagent-approvals&id=child&nonAdmin')
  await expect(page.locator('[data-slot="subagent-banner"]')).toBeVisible()
  await expect(picker(page)).toHaveCount(0)
})

test('keeps typing and sends chat messages independently of the current approval', async ({
  page,
}) => {
  await page.goto(
    '/?fixture=subagent-approvals&id=parent&localApproval&delayedApprovals',
  )
  const editor = composer(page)
  await editor.fill('Keep this draft')
  await page.keyboard.press('End')
  await releaseApprovals(page)
  await expect(review(page)).toBeVisible()
  await expect(picker(page)).toHaveCount(0)
  await expect(editor).toBeFocused()
  await page.keyboard.press('1')
  await expect(editor).toHaveText('Keep this draft1')
  expect(await mutations(page)).toEqual([])

  await review(page).click()
  await expect(picker(page)).toContainText('git push origin local')
  await expect(actions(page)).toBeFocused()
  await expect(note(page)).toHaveText('')
  await note(page).fill('Use the test remote')

  const hide = picker(page).getByRole('button', { name: 'Hide', exact: true })
  await hide.focus()
  await page.keyboard.press('Enter')
  await expect(editor).toBeFocused()
  await expect(editor).toHaveText('Keep this draft1')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(editor).toHaveText('')
  await page.getByRole('button', { name: 'Stop typing', exact: true }).focus()
  await expect(review(page)).toBeVisible()
  await expect(picker(page)).toHaveCount(0)
  expect(await mutations(page)).toEqual([
    {
      name: 'chat:sendMessage',
      args: { sessionId: 'parent', content: 'Keep this draft1' },
    },
  ])

  await review(page).press('Enter')
  await expect(picker(page)).toContainText('git push origin local')
  await expect(actions(page)).toBeFocused()
  await expect(note(page)).toHaveText('Use the test remote')
  await actions(page).dispatchEvent('keydown', { key: 'Enter', repeat: true })
  await actions(page).dispatchEvent('keydown', { key: '1', isComposing: true })
  await note(page).focus()
  await note(page).dispatchEvent('keydown', {
    key: 'Escape',
    isComposing: true,
  })
  expect(await mutations(page)).toHaveLength(1)
  await expect(note(page)).toBeFocused()
  const allow = picker(page).getByRole('option', { name: /^Allow(?:\s+1)?$/ })
  await expect(allow).toHaveAttribute('aria-selected', 'true')
  await picker(page)
    .getByRole('option', { name: /^Deny/ })
    .dispatchEvent('pointermove', { pointerType: 'mouse' })
  await expect(allow).toHaveAttribute('aria-selected', 'true')
  await note(page).press('ControlOrMeta+Enter')
  await expect
    .poll(() => mutations(page))
    .toContainEqual({
      name: 'chat:approveTool',
      args: {
        sessionId: 'parent',
        toolCallId: 'local',
        approved: true,
        note: 'Use the test remote',
      },
    })
  await resolveApproval(page)
})

test('keeps the fullscreen draft open until the user chooses to review', async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      'corvori-composer-drafts',
      JSON.stringify({
        parent: { text: 'Keep this draft', updatedAt: Date.now() },
      }),
    )
  })
  await page.goto('/?fixture=subagent-approvals&id=parent&delayedApprovals')
  const editor = composer(page)
  await expect(editor).toHaveText('Keep this draft')
  await page.getByRole('button', { name: 'Full screen', exact: true }).click()
  const expanded = page.getByRole('dialog', { name: 'Expanded editor' })
  await expect(expanded).toBeVisible()

  await releaseApprovals(page)
  const expandedReview = expanded.getByRole('button', {
    name: 'Review approval',
  })
  await expect(expandedReview).toBeVisible()
  await expect(picker(page)).toHaveCount(0)
  await expandedReview.click()
  await expect(expanded).toHaveCount(0)
  await expect(actions(page)).toBeFocused()

  await picker(page).getByRole('button', { name: 'Hide', exact: true }).click()
  await expect(picker(page)).toHaveCount(0)
  await expect(editor).toBeFocused()
  await expect(editor).toHaveText('Keep this draft')
  await page.getByRole('button', { name: 'Full screen', exact: true }).click()
  await expect(expandedReview).toBeVisible()
})

test('dispatched shell approvals display target arguments and submit the original call ID', async ({
  page,
}) => {
  await page.goto('/?fixture=subagent-approvals&id=child&dispatched')
  await expect(picker(page)).toContainText('git push origin first')
  await note(page).fill('Approve the dispatched shell target')
  await note(page).press('ControlOrMeta+Enter')
  await expect(picker(page)).toContainText('git push origin second')
  expect((await mutations(page))[0].args).toMatchObject({
    sessionId: 'parent',
    childSessionId: 'child',
    toolCallId: 'first',
    approved: true,
    note: 'Approve the dispatched shell target',
  })
  await resolveApproval(page)
})
