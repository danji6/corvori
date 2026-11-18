import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.goto('/?fixture=mcp-settings')
})

test('server card header controls stay independent of its accessible trigger', async ({
  page,
}) => {
  await page.goto('/?fixture=mcp-settings&view=card')
  const trigger = page.getByRole('button', { name: 'Expand', exact: true })
  const url = page.getByPlaceholder('http://localhost:11235/mcp')
  const content = page.locator('[data-slot="collapsible-content"]').first()
  await expect(content).toHaveAttribute('aria-hidden', 'true')
  await expect(content).toHaveCSS('opacity', '0')
  await trigger.focus()
  await page.keyboard.press('Enter')
  const collapse = page.getByRole('button', { name: 'Collapse', exact: true })
  await expect(collapse).toHaveAttribute('aria-expanded', 'true')
  await expect(url).toBeVisible()
  const labelAlignment = await url.evaluate((input) => {
    const style = getComputedStyle(input)
    const textStart =
      input.getBoundingClientRect().left +
      parseFloat(style.borderLeftWidth) +
      parseFloat(style.paddingLeft)
    const labels = document.querySelectorAll(
      '[data-slot="settings-field"] label',
    )
    return [...labels].map((label) =>
      Math.abs(label.getBoundingClientRect().left - textStart),
    )
  })
  for (const difference of labelAlignment) {
    expect(difference).toBeLessThanOrEqual(1)
  }
  const contentId = await collapse.getAttribute('aria-controls')
  await expect(page.locator(`[id="${contentId}"]`)).toContainText('Probe')
  await page.getByPlaceholder('Label', { exact: true }).fill('Renamed')
  await page.getByRole('switch').first().click()
  await expect(page.getByRole('switch').first()).not.toBeChecked()
  await expect(url).toBeVisible()
  await page.getByRole('button', { name: 'Probe', exact: true }).click()
  await expect(page.getByRole('combobox')).toContainText('Auto (SSE)')
  await page.getByRole('button', { name: 'Move down' }).click()
  await expect(page.getByLabel('Card action')).toHaveText('Move 1')
  await expect(url).toBeVisible()
  await page.screenshot({ path: '/tmp/corvori-mcp-server-card.png' })
  await collapse.focus()
  await page.keyboard.press('Space')
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')
  await expect(content).toHaveAttribute('aria-hidden', 'true')
  await expect(content).toHaveCSS('opacity', '0')
  await expect(page.getByPlaceholder('Label', { exact: true })).toHaveValue(
    'Renamed',
  )
  await page.getByRole('button', { name: 'Remove', exact: true }).click()
  await expect(page.getByLabel('Card action')).toHaveText('Remove')
})

test('local argv and environment are edited without shell parsing', async ({
  page,
}) => {
  await page
    .getByRole('textbox', { name: 'MCP command', exact: true })
    .fill('npx')
  await page
    .getByRole('textbox', { name: 'MCP arguments', exact: true })
    .fill('["-y","toolkit@1.0.0","$(touch should-not-run)"]')
  await page
    .getByRole('textbox', { name: 'MCP environment', exact: true })
    .fill('{"MODE":"analysis"}')
  await page.getByRole('button', { name: 'Validate connection' }).click()
  await expect(page.getByLabel('Connection result')).toContainText(
    '$(touch should-not-run)',
  )
  await expect(page.getByLabel('Connection result')).toContainText(
    '"MODE":"analysis"',
  )
})

test('invalid argv and missing commands produce validation errors', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Validate connection' }).click()
  await expect(page.getByLabel('Connection result')).toContainText(
    'local command is required',
  )
  await page
    .getByRole('textbox', { name: 'MCP command', exact: true })
    .fill('node')
  await page
    .getByRole('textbox', { name: 'MCP arguments', exact: true })
    .fill('{"wrong":true}')
  await page.getByRole('button', { name: 'Validate connection' }).click()
  await expect(page.getByLabel('Connection result')).toContainText(
    'JSON array of strings',
  )
})

test('secret values are masked and excluded from the saved preview', async ({
  page,
}) => {
  await page
    .getByRole('textbox', { name: 'MCP command', exact: true })
    .fill('node')
  const secrets = page.getByLabel('MCP secret environment', { exact: true })
  await expect(secrets).toHaveAttribute('type', 'password')
  await secrets.fill('{"TOKEN":"private-fixture-value"}')
  await page.getByRole('button', { name: 'Validate connection' }).click()
  await expect(page.getByLabel('Connection result')).toContainText('TOKEN')
  await expect(page.getByLabel('Connection result')).not.toContainText(
    'private-fixture-value',
  )
})

test('startup, inactivity and absolute deadlines are independently editable', async ({
  page,
}) => {
  await page
    .getByRole('textbox', { name: 'MCP command', exact: true })
    .fill('node')
  await page
    .getByRole('spinbutton', { name: 'MCP startup timeout', exact: true })
    .fill('45000')
  await page
    .getByRole('spinbutton', { name: 'MCP inactivity timeout', exact: true })
    .fill('600000')
  await page
    .getByRole('spinbutton', { name: 'MCP absolute timeout', exact: true })
    .fill('1800000')
  await page.getByRole('button', { name: 'Validate connection' }).click()
  await expect(page.getByLabel('Connection result')).toContainText(
    '"startupTimeoutMs":45000',
  )
  await expect(page.getByLabel('Connection result')).toContainText(
    '"requestTimeoutMs":600000',
  )
  await expect(page.getByLabel('Connection result')).toContainText(
    '"maxTotalTimeoutMs":1800000',
  )
})

test('each timeout can be reset independently to its default', async ({
  page,
}) => {
  await page
    .getByRole('textbox', { name: 'MCP command', exact: true })
    .fill('node')
  const timeouts = [
    { label: 'MCP startup timeout', defaultValue: '30000' },
    { label: 'MCP inactivity timeout', defaultValue: '300000' },
    { label: 'MCP absolute timeout', defaultValue: '1800000' },
  ]
  for (const { label } of timeouts) {
    await page
      .getByRole('spinbutton', { name: label, exact: true })
      .fill('90000')
  }
  for (const [index, { label, defaultValue }] of timeouts.entries()) {
    const reset = page.getByRole('button', {
      name: `Reset ${label} to default`,
    })
    await reset.click()
    await expect(
      page.getByRole('spinbutton', { name: label, exact: true }),
    ).toHaveValue(defaultValue)
    await expect(reset).toBeDisabled()
    for (const pending of timeouts.slice(index + 1)) {
      await expect(
        page.getByRole('spinbutton', { name: pending.label, exact: true }),
      ).toHaveValue('90000')
    }
  }
  await page.getByRole('button', { name: 'Validate connection' }).click()
  const output = page.getByLabel('Connection result')
  await expect(output).toContainText('"startupTimeoutMs":30000')
  await expect(output).toContainText('"requestTimeoutMs":300000')
  await expect(output).toContainText('"maxTotalTimeoutMs":1800000')
})

test('progress without a total never invents a percentage', async ({
  page,
}) => {
  const status = page.getByRole('status').filter({ hasText: 'Analyzing' })
  await expect(status).toHaveText('Analyzing · 3')
  await expect(status).not.toContainText('%')
  await page.getByRole('button', { name: 'Toggle progress total' }).click()
  await expect(status).toHaveText('Analyzing · 3 / 10')
})

test('tool discovery help opens independently of the labeled switch', async ({
  page,
}) => {
  const toggle = page.getByRole('switch', {
    name: 'Exclude tools from context',
  })
  const help = page.getByRole('button', {
    name: 'About Exclude tools from context',
  })
  await expect(toggle).not.toBeChecked()
  await help.click()
  await expect(page.getByText(/This keeps its starting context/)).toBeVisible()
  await expect(page.getByText(/When off, you select individual/)).toBeVisible()
  await expect(toggle).not.toBeChecked()
  await page.keyboard.press('Escape')
  await expect(page.getByText(/This keeps its starting context/)).toBeHidden()
  await page.getByText('Exclude tools from context', { exact: true }).click()
  await expect(toggle).toBeChecked()
  await toggle.focus()
  await page.keyboard.press('Space')
  await expect(toggle).not.toBeChecked()
})
