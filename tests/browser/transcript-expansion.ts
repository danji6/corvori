import { type Locator, expect } from '@playwright/test'

/** Checks the chosen viewport edge through the panel transition. */
export async function expectAnchoredExpansion(
  trigger: Locator,
  anchor: 'top' | 'bottom',
) {
  const { start, end, positions, backtrack, rowDrift } = await trigger.evaluate(
    async (element, anchor) => {
      const button = element as HTMLButtonElement
      const row = button.closest('[data-row-key]')!
      const start = scrollY
      const rowBottom = row.getBoundingClientRect().bottom
      const position = () =>
        anchor === 'top'
          ? scrollY
          : document.documentElement.scrollHeight - innerHeight - scrollY
      const initialPosition = position()
      const positions: number[] = []
      const deadline = performance.now() + 5000
      let lastHeight = -1
      let stableFrames = 0
      let furthest = start
      let backtrack = 0
      let rowDrift = 0
      button.click()

      while (performance.now() < deadline) {
        // Sample after the frame's layout and resize observers have run.
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => setTimeout(resolve, 0))
        })
        const panel = document.getElementById(
          button.getAttribute('aria-controls')!,
        )
        const height = document.documentElement.scrollHeight
        const expanded = panel?.style.gridTemplateRows === '1fr'
        const settled = expanded && !panel.getAnimations().length
        stableFrames = settled && height === lastHeight ? stableFrames + 1 : 0
        lastHeight = height
        positions.push(position() - initialPosition)
        furthest = Math.max(furthest, scrollY)
        backtrack = Math.max(backtrack, furthest - scrollY)
        rowDrift = Math.max(
          rowDrift,
          Math.abs(row.getBoundingClientRect().bottom - rowBottom),
        )
        if (stableFrames >= 8)
          return { start, end: scrollY, positions, backtrack, rowDrift }
      }
      throw new Error('The transcript panel did not finish expanding')
    },
    anchor,
  )

  expect(Math.max(...positions.map(Math.abs))).toBeLessThanOrEqual(1)
  if (anchor === 'bottom') {
    expect(end).toBeGreaterThan(start)
    expect(backtrack).toBeLessThanOrEqual(1)
    expect(rowDrift).toBeLessThanOrEqual(1)
  }
}
