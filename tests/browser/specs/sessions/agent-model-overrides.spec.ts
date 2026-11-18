import { expect, test } from '@playwright/test'

test('the composer displays model and reasoning locks independently', async ({
  page,
}) => {
  await page.goto('/?fixture=provider-connections&agentOverrides')
  const agent = page.getByRole('combobox', {
    name: 'Select agent',
    exact: true,
  })
  const model = page.getByLabel('Select model', { exact: true })
  const reasoning = page.getByLabel('Select reasoning effort')
  await agent.click()
  await expect(model).toContainText('Binary model')
  await expect(model).toBeDisabled()
  await expect(
    page.getByText('Model (Overridden)', { exact: true }),
  ).toBeVisible()
  const binary = page.getByRole('switch', { name: 'Enable reasoning' })
  await expect(binary).toBeDisabled()
  await expect(binary).not.toBeChecked()
  await expect(
    page.getByText('Reasoning (Overridden)', { exact: true }),
  ).toBeVisible()

  await page.getByRole('option', { name: 'Model only agent' }).click()
  await expect(agent).toContainText('Model only agent')
  await agent.click()
  await expect(model).toContainText('Tiered model')
  await expect(model).toBeDisabled()
  await expect(reasoning).toContainText('Low')
  await expect(reasoning).toBeEnabled()

  await page.getByRole('option', { name: 'Inherited agent' }).click()
  await expect(agent).toContainText('Inherited agent')
  await agent.click()
  await expect(model).toContainText('Same model')
  await expect(model).toBeEnabled()
})

test('the agent editor uses model-specific reasoning and the parent shows the child’s locks', async ({
  page,
}) => {
  await page.goto('/?fixture=provider-connections&agentOverrides')
  const model = page.getByLabel('Model override', { exact: true })
  const reasoning = page.getByLabel('Reasoning override', { exact: true })
  const modelLabel = page.getByText('Model (Override)', { exact: true })
  await expect(modelLabel).toBeVisible()
  await expect(reasoning).toHaveCount(0)
  await model.click()
  await page.getByRole('option', { name: 'Binary model' }).click()
  await expect(
    page.getByText('Reasoning (Override)', { exact: true }),
  ).toBeVisible()

  const modelBox = (await model.boundingBox())!
  const reasoningBox = (await reasoning.boundingBox())!
  const labelBox = (await modelLabel.boundingBox())!
  expect(modelBox.x).toBeGreaterThan(labelBox.x + labelBox.width)
  expect(
    Math.abs(modelBox.x + modelBox.width - reasoningBox.x - reasoningBox.width),
  ).toBeLessThan(2)

  await reasoning.click()
  await expect(
    page.getByRole('option', { name: 'On', exact: true }),
  ).toBeVisible()
  await page.getByRole('option', { name: 'Off', exact: true }).click()
  await expect(reasoning).toContainText('Off')
  await model.click()
  await page
    .getByRole('listbox', { name: 'Suggestions' })
    .getByRole('option', { name: 'Inherit', exact: true })
    .click()
  await expect(reasoning).toHaveCount(0)

  await page
    .getByRole('button', { name: 'Configure Pinned agent model and reasoning' })
    .click()
  const childModel = page.getByLabel('Subagent model')
  await expect(childModel).toContainText('Binary model')
  await expect(childModel).toBeDisabled()
  const childReasoning = page.getByLabel('Subagent reasoning')
  await expect(childReasoning).toContainText('Off')
  await expect(childReasoning).toBeDisabled()
})
