import { type Locator, expect, test } from '@playwright/test'

function sampleTransition(panel: Locator, layer: string) {
  return panel.evaluate(async (panel, layer) => {
    const measure = () =>
      ['expanded', 'collapsed'].flatMap((state) =>
        ['header', 'content', 'footer'].map((slot) => {
          const element = panel.querySelector(
            `[data-slot="sidebar-${state}"] [data-slot="sidebar-${slot}"]`,
          )!
          const { y, height } = element.getBoundingClientRect()
          return { y, height, scrollTop: element.scrollTop }
        }),
      )
    const samples = [measure()]
    const toggle = panel.querySelector<HTMLButtonElement>(
      `[data-slot="sidebar-${layer}"] [data-slot="sidebar-toggle"] button:last-child`,
    )!
    toggle.click()
    const start = performance.now()
    do {
      await new Promise(requestAnimationFrame)
      samples.push(measure())
    } while (performance.now() - start < 300)
    return samples
  }, layer)
}

for (const side of ['left', 'right']) {
  test(`${side} sidebar preserves vertical layout throughout collapse and expansion`, async ({
    page,
  }) => {
    await page.goto(`/?fixture=sidebar&side=${side}`)
    const panel = page.locator('[data-slot="sidebar-panel"]')
    await expect(panel).toHaveAttribute('data-collapsed', 'false')

    for (const layer of ['expanded', 'collapsed']) {
      const samples = await sampleTransition(panel, layer)

      for (const sample of samples) expect(sample).toEqual(samples[0])
      await expect(panel).toHaveAttribute(
        'data-collapsed',
        String(layer === 'expanded'),
      )
    }
  })
}

test('the sidebar scrollbar overlays the viewport and hides after use', async ({
  page,
}) => {
  await page.goto('/?fixture=sidebar&side=right')
  const viewport = page.locator(
    '[data-slot="sidebar-expanded"] [data-slot="sidebar-content"]',
  )
  const thumb = viewport.locator('[data-slot="overlay-scrollbar-thumb"]')
  const scrollTop = () => viewport.evaluate((element) => element.scrollTop)
  const gutter = () =>
    viewport.evaluate(
      (element: HTMLDivElement) => element.offsetWidth - element.clientWidth,
    )

  await expect(viewport).toHaveCSS('scrollbar-width', 'none')
  await expect(thumb).toHaveCSS('opacity', '0')
  expect(await gutter()).toBe(0)

  await viewport.hover()
  await page.mouse.wheel(0, 180)
  await expect.poll(scrollTop).toBeGreaterThan(0)
  await expect(thumb).toHaveCSS('opacity', '1')
  expect(await gutter()).toBe(0)

  const beforeDrag = await scrollTop()
  const { x, y, width, height } = (await thumb.boundingBox())!
  await page.mouse.move(x + width / 2, y + height / 2)
  await page.mouse.down()
  await page.mouse.move(x + width / 2, y + height / 2 + 50)
  await page.mouse.up()
  await expect.poll(scrollTop).toBeGreaterThan(beforeDrag)
  expect(await page.evaluate(() => window.scrollY)).toBe(0)
  await expect(thumb).toHaveCSS('opacity', '0')
  expect(await gutter()).toBe(0)
})
