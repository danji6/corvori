import { type Page, expect, test } from '@playwright/test'

test('forwards input for a user shell without a wait signal', async ({
  page,
}) => {
  await page.goto('/?fixture=notes&id=notes&shellReports&interactiveShell')
  const shell = page.locator('[data-slot="shell-block"]').first()
  await expect(shell.locator('.xterm')).toBeVisible()
  await expect(shell.locator('.xterm-helper-textarea')).not.toBeFocused()
  await shell.locator('.xterm').click()
  await page.keyboard.insertText('dummy')
  await page.keyboard.press('Enter')
  await expect(page.locator('body')).toHaveAttribute(
    'data-terminal-input',
    'dummy\r',
  )
})

async function showShellAtBottom(page: Page, height: number) {
  await page.setViewportSize({ width: 1100, height })
  await page.goto('/?fixture=notes&id=notes&fileChanges&longShell')
  await page.locator('[data-slot="work-block"]').click()
  await expect(
    page.locator('[data-slot="virtualized-row-transition"][data-state]'),
  ).toHaveCount(0)
  const shell = page.locator('[data-slot="shell-block"]')
  const trigger = shell.locator('[data-block-trigger]')
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')
  await expect
    .poll(() =>
      page.evaluate(() => {
        window.scrollTo(0, document.documentElement.scrollHeight)
        return document.documentElement.scrollHeight - scrollY - innerHeight
      }),
    )
    .toBeLessThanOrEqual(1)
  await expect(trigger).toBeInViewport({ ratio: 1 })
  return { shell, trigger }
}

test('opening a shell command scrolls only enough to reveal its output', async ({
  page,
}) => {
  const height = 760
  const { shell, trigger } = await showShellAtBottom(page, height)
  await trigger.evaluate((button) => {
    const triggerButton = button as HTMLButtonElement
    // Leave room to scroll past the output and preserve the starting viewport.
    const scrollTop = window.scrollY
    button.closest('main')!.style.paddingBottom = '100vh'
    document.scrollingElement!.scrollTop = scrollTop
    // Apply the requested distance immediately so the test measures its destination.
    const scrollBy = window.scrollBy.bind(window)
    window.scrollBy = (options?: ScrollToOptions | number, y?: number) => {
      if (typeof options === 'object') {
        scrollBy({ ...options, behavior: 'instant' })
        if (options.behavior === 'smooth') {
          document.documentElement.dataset.shellReveal = 'done'
        }
      } else {
        scrollBy(options ?? 0, y ?? 0)
      }
    }
    triggerButton.click()
  })

  await expect(trigger).toHaveAttribute('aria-expanded', 'true')
  await expect(page.locator('html')).toHaveAttribute(
    'data-shell-reveal',
    'done',
  )
  const terminal = shell.locator('[data-slot="terminal-wrapper"]')
  const output = (await terminal.boundingBox())!
  expect(output.y + output.height).toBeLessThanOrEqual(height - 80)
  expect((await trigger.boundingBox())!.y).toBeGreaterThan(140)
})

test('a live shell waiting for input still reveals the terminal automatically', async ({
  page,
}) => {
  let allowTerminal!: () => void
  let terminalRequested!: () => void
  const request = new Promise<void>((resolve) => {
    terminalRequested = resolve
  })
  const release = new Promise<void>((resolve) => {
    allowTerminal = resolve
  })
  await page.route(/\/assets\/terminal-view-[^/]+\.js$/, async (route) => {
    terminalRequested()
    await release
    await route.continue()
  })
  const { shell, trigger } = await showShellAtBottom(page, 760)
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur())
  try {
    await page
      .getByRole('button', { name: 'Wait for terminal input' })
      .evaluate((button) => (button as HTMLButtonElement).click())
    await expect(trigger).toHaveAttribute('aria-expanded', 'true')
    await request
    await expect(shell.locator('.xterm')).toHaveCount(0)
  } finally {
    allowTerminal()
  }
  const terminal = shell.locator('[data-slot="terminal-wrapper"]')
  await expect(terminal.locator('.xterm-helper-textarea')).toBeFocused()
  await page.keyboard.insertText('dummy')
  await page.keyboard.press('Enter')
  await expect(page.locator('body')).toHaveAttribute(
    'data-terminal-input',
    'dummy\r',
  )
  await expect
    .poll(async () => {
      const box = await terminal.boundingBox()
      return box ? box.y + box.height : Infinity
    })
    .toBeLessThanOrEqual(680)
  expect((await trigger.boundingBox())!.y).toBeGreaterThan(120)

  const otherControl = page.getByRole('button', {
    name: 'Append terminal output',
  })
  await otherControl.focus()
  await otherControl.evaluate((button) => (button as HTMLButtonElement).click())
  await expect(otherControl).toBeFocused()
})

async function submitShell(page: Page) {
  await page.setViewportSize({ width: 1100, height: 760 })
  await page.goto('/?fixture=notes&id=notes&shellComposer')
  const composer = page.locator('[data-slot="chat-box"]')
  const editor = composer.locator('[contenteditable="true"]')
  await expect(composer).toBeInViewport({ ratio: 1 })
  await editor.fill('$ cat index.html')
  await composer.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(editor).toHaveText('')
  const shell = page.locator('[data-slot="shell-block"]')
  const trigger = shell.locator('[data-block-trigger]')
  await expect(trigger).toBeAttached()
  await page.evaluate(() => {
    const doc = document.scrollingElement!
    doc.scrollTop = doc.scrollHeight
  })
  await expect(trigger).toBeInViewport({ ratio: 1 })
  return { composer, editor, shell, trigger }
}

async function publishShellOutput(
  page: Page,
  { cancel = false, waiting = false } = {},
) {
  await page.evaluate(
    ({ cancel, waiting }) => {
      const list = document.querySelector<HTMLElement>(
        '[data-slot="message-list"]',
      )!
      list.style.paddingBottom = '100vh'
      const scrollBy = window.scrollBy.bind(window)
      window.scrollBy = (options?: ScrollToOptions | number, y?: number) => {
        if (typeof options === 'object' && options.behavior === 'smooth') {
          document.documentElement.dataset.shellReveal = 'scrolled'
          scrollBy({ ...options, behavior: 'instant' })
        } else if (typeof options === 'object') {
          scrollBy(options)
        } else {
          scrollBy(options ?? 0, y ?? 0)
        }
      }
      if (cancel) {
        const shell = list.querySelector('[data-slot="shell-block"]')!
        const observer = new MutationObserver(() => {
          if (shell.getAttribute('data-open') !== 'true') return
          observer.disconnect()
          requestAnimationFrame(() => {
            list.dispatchEvent(
              new WheelEvent('wheel', { bubbles: true, deltaY: -100 }),
            )
            document.documentElement.dataset.shellReveal = 'cancelled'
          })
        })
        observer.observe(shell, {
          attributes: true,
          attributeFilter: ['data-open'],
        })
      }
      window.dispatchEvent(
        new CustomEvent('publish-submitted-shell-output', { detail: waiting }),
      )
    },
    { cancel, waiting },
  )
}

test('a submitted shell reveals output and keeps the empty composer docked until scrolling', async ({
  page,
}) => {
  const { composer, shell } = await submitShell(page)
  await publishShellOutput(page)
  await expect(page.locator('html')).toHaveAttribute(
    'data-shell-reveal',
    'scrolled',
  )
  await expect(shell.locator('[data-slot="terminal-wrapper"]')).toBeInViewport({
    ratio: 1,
  })
  await expect(composer).toBeInViewport({ ratio: 1 })
  await expect(
    page.getByRole('button', { name: 'Scroll to bottom' }),
  ).toBeVisible()
  await page.mouse.move(120, 320)
  await page.mouse.wheel(0, -380)
  await expect(composer).not.toBeInViewport()
})

test('a cancelled shell reveal releases the composer override', async ({
  page,
}) => {
  const { composer, trigger } = await submitShell(page)
  await publishShellOutput(page, { cancel: true })
  await expect(trigger).toHaveAttribute('aria-expanded', 'true')
  await expect(composer).not.toBeInViewport()
  await expect(page.locator('html')).toHaveAttribute(
    'data-shell-reveal',
    'cancelled',
  )
})

for (const newerDraft of [false, true]) {
  test(`a submitted waiting shell respects composer focus (newerDraft=${newerDraft})`, async ({
    page,
  }) => {
    const { editor, shell } = await submitShell(page)
    if (newerDraft) await editor.fill('Next message')
    await publishShellOutput(page, { waiting: true })
    const input = shell.locator('.xterm-helper-textarea')
    await expect(input).toBeAttached()
    await expect(page.locator('html')).toHaveAttribute(
      'data-shell-reveal',
      'scrolled',
    )
    if (newerDraft) {
      await page.keyboard.insertText(' draft')
      await expect(editor).toHaveText('Next message draft')
    } else {
      await expect(input).toBeFocused()
      await exitSubmittedShell(page)
      await expect(editor).toBeFocused()
      await page.keyboard.insertText('Next message')
      await expect(editor).toHaveText('Next message')
    }
  })
}

async function exitSubmittedShell(page: Page, empty = false) {
  await page.evaluate((empty) => {
    window.dispatchEvent(
      new CustomEvent('publish-submitted-shell-output', {
        detail: empty ? 'empty-exit' : false,
      }),
    )
  }, empty)
}

test('a focused shell can restore a hidden composer when its terminal disappears', async ({
  page,
}) => {
  const { composer, editor, shell } = await submitShell(page)
  await publishShellOutput(page, { waiting: true })
  const input = shell.locator('.xterm-helper-textarea')
  await expect(input).toBeFocused()
  await expect(
    page.getByRole('button', { name: 'Scroll to bottom' }),
  ).toBeVisible()
  await page.mouse.move(120, 320)
  await page.mouse.wheel(0, -32)
  await expect(composer).not.toBeInViewport()
  await expect(input).toBeFocused()

  await exitSubmittedShell(page, true)
  await expect(input).toHaveCount(0)
  await expect(editor).toBeFocused()
  await expect(composer).toBeInViewport({ ratio: 1 })
  await expect(
    page.getByRole('button', { name: 'Scroll to bottom' }),
  ).toBeVisible()
})

test('a shell exit leaves focus on the control the user moved to', async ({
  page,
}) => {
  const { shell, trigger } = await submitShell(page)
  await publishShellOutput(page, { waiting: true })
  const input = shell.locator('.xterm-helper-textarea')
  await expect(input).toBeFocused()
  await trigger.focus()
  await exitSubmittedShell(page)
  await expect(
    shell.getByRole('button', { name: 'Kill Terminal' }),
  ).toHaveCount(0)
  await expect(trigger).toBeFocused()
})

for (const grouped of [true, false]) {
  test(`shell commands and reports share shell groups (grouped=${grouped})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 1200 })
    await page.goto(
      `/?fixture=notes&id=notes&shellReports${grouped ? '' : '&ungrouped'}`,
    )
    await expect(page.locator('[data-slot="message-header"]')).toHaveCount(
      grouped ? 2 : 4,
    )
    const report = page.locator(
      '[data-slot="message-row"][data-message-id="shell2"]',
    )
    await expect(
      report.locator('[data-slot="shell-report-block"]'),
    ).toHaveCount(0)
    const work = page.locator('[data-slot="work-block"]')
    await expect(work).toHaveCount(grouped ? 2 : 3)
    await expect(work.first()).toContainText('Ran 2 commands')
    for (const block of await work.all()) await block.click()
    await expect(
      page.locator('[data-slot="virtualized-row-transition"][data-state]'),
    ).toHaveCount(0)
    await expect(report.first()).toHaveAttribute('data-role', 'assistant')

    const groups = page.locator('[data-slot="shell-group"]')
    await expect(groups).toHaveCount(3)
    await expect(groups.nth(0)).toContainText('Ran 1 command')
    await expect(groups.nth(1)).toContainText('Ran 2 commands')
    await expect(groups.nth(2)).toContainText('Ran 1 command')
    const commandTriggers = groups.nth(1).locator('[data-block-trigger]')
    await expect(commandTriggers.first().locator('.shiki .line')).toBeVisible()
    await commandTriggers.first().focus()
    await page.keyboard.press('Tab')
    await expect(commandTriggers.nth(1)).toBeFocused()
    const output = page.locator('[data-tool-call-id="poll"]')
    const nextOutput = page.locator('[data-tool-call-id="poll-next"]')
    await expect(output.getByRole('button')).toHaveText(
      'Read output of job job',
      { useInnerText: true },
    )
    await expect(nextOutput.getByRole('button')).toHaveText(
      'Read output of job next-job',
      { useInnerText: true },
    )
    await expect(
      output.getByText('Command output', { exact: true }),
    ).toBeHidden()
    await output.getByRole('button').focus()
    await page.keyboard.press('Enter')
    await expect(
      output.getByText('Command output', { exact: true }),
    ).toBeVisible()
    await nextOutput.getByRole('button').click()
    await expect(nextOutput.getByText('Next command output')).toBeVisible()
    await output.getByRole('button').click()
    await expect(
      output.getByText('Command output', { exact: true }),
    ).toBeHidden()
    await expect(nextOutput.getByText('Next command output')).toBeVisible()
    await expect(groups.nth(0)).toContainText('user output')
    await expect(groups.nth(2).getByText('Lint passed')).toBeHidden()
    await groups.nth(2).getByRole('button').click()
    await expect(groups.nth(2).getByText('Lint passed')).toBeVisible()
    await work.first().click()
    if (grouped) {
      await expect(
        report.locator('[data-slot="shell-report-block"]'),
      ).toHaveCount(0)
      await expect(work.first()).toContainText('Ran 2 commands')
      await page.getByRole('button', { name: 'Seek report' }).click()
      await expect(work.first()).toHaveAttribute('aria-expanded', 'true')
      await expect(
        report.locator('[data-slot="shell-report-block"]'),
      ).toBeVisible()
    }
    await expect(
      page.locator(
        '[data-slot="shell-block"]:not([data-slot="shell-group"] *)',
      ),
    ).toHaveCount(2)
    if (grouped) {
      await expect(page.locator('[data-slow="message-footer"]')).toHaveCount(1)
      await expect(page.locator('[data-slow="message-footer"]')).toContainText(
        '2m26s',
      )
    }
  })
}
