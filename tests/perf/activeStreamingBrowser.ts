import { type Page, chromium, expect } from '@playwright/test'
import { strict as assert } from 'node:assert'

import type { Provider, User } from './activeStreaming'
import { observeTurn, verifyText } from './activeStreamingObserver'
import { now, streamScript } from './activeStreamingProvider'
import { intervalsFor, latency, overlap } from './activeStreamingReport'
import { deadline } from './clients'
import type { Deployment } from './deployment'

type BrowserMode = 'chromium' | 'chromium-fast'
type RenderSample = { at: number; length: number }
type RenderWindow = Window & { benchmarkRenders?: RenderSample[] }

async function observeRendering(page: Page) {
  await page.evaluate(() => {
    const samples: RenderSample[] = []
    ;(window as RenderWindow).benchmarkRenders = samples
    new MutationObserver(() => {
      const text = document.querySelector(
        '[data-role="assistant"] .chat-markdown',
      )
      if (!text?.getBoundingClientRect().height) return
      const length = text.textContent?.trim().length ?? 0
      if (!length || length === samples.at(-1)?.length) return
      samples.push({ at: performance.timeOrigin + performance.now(), length })
    }).observe(document.body, {
      childList: true,
      characterData: true,
      subtree: true,
    })
  })
}

async function clickStop(page: Page) {
  // The composer reuses the Send button and switches its action during output.
  const button = page.getByRole('button', { name: 'Send', exact: true })
  const clickedAt = Promise.withResolvers<number>()
  await page.exposeFunction('recordBenchmarkStop', clickedAt.resolve)
  await button.evaluate((element) => {
    element.addEventListener(
      'click',
      () => {
        const benchmarkWindow = window as Window & {
          recordBenchmarkStop?: (at: number) => void
        }
        benchmarkWindow.recordBenchmarkStop?.(
          performance.timeOrigin + performance.now(),
        )
      },
      { capture: true, once: true },
    )
  })
  await button.click()
  return deadline(clickedAt.promise, 'the composer Stop click')
}

async function browserBatch(
  page: Page,
  deployment: Deployment,
  frontend: string,
  provider: Provider,
  users: User[],
  round: number,
  mode: BrowserMode,
) {
  const stopping = mode === 'chromium'
  const turns = await Promise.all(
    users.map(async ({ account, session }, index) => {
      const id = await session()
      // Slow text allows Playwright to click before the response finishes.
      const script = streamScript(
        index,
        `${mode}-${users.length}-${round}-${index}`,
        stopping ? 'slow' : 'fast',
      )
      return {
        id,
        script,
        observer: observeTurn(deployment, account, id, script),
      }
    }),
  )
  try {
    const [{ id, script, observer }] = turns
    await page.goto(`${frontend}/?id=${id}`)
    const composer = page.locator('[contenteditable="true"]').first()
    await expect(composer).toBeEditable({ timeout: 20_000 })
    await observeRendering(page)
    await Promise.all(turns.map((turn) => turn.observer.ready()))
    turns.forEach((turn) => provider.schedule(turn.script))
    const firstRendered = page.waitForFunction(
      () => (window as RenderWindow).benchmarkRenders?.[0]?.at ?? false,
      undefined,
      { timeout: 30_000 },
    )
    const sent = now()
    const [, rendered] = await Promise.all([
      Promise.all(turns.map((turn) => turn.observer.send())),
      firstRendered,
    ])
    const renderedAt = await rendered.jsonValue()
    assert.ok(renderedAt, 'Missing visible assistant text')
    const clickedAt = stopping ? await clickStop(page) : undefined
    const [[end, final]] = await Promise.all(
      turns.map(async (turn, index) => {
        const [end, final] = await Promise.all([
          turn.script.ended(),
          turn.observer.final(),
        ])
        const stopped = stopping && index === 0
        assert.equal(end.kind, stopped ? 'disconnected' : 'finished')
        verifyText(turn.script, turn.observer.updates, final.text, stopped)
        return [end, final] as const
      }),
    )
    const answer = page.locator('[data-role="assistant"] .chat-markdown')
    await expect(answer).toHaveText(final.text)
    assert.ok(final.text, 'Browser turn has no persisted output')
    const renders = await page.evaluate(
      () => (window as RenderWindow).benchmarkRenders ?? [],
    )
    assert.equal(renders.at(-1)?.length, final.text.length)
    provider.verify()
    return {
      peak: overlap(await intervalsFor(turns.map((turn) => turn.script))),
      render: renderedAt - sent,
      providerToRender: renderedAt - script.chunks[0].at,
      subscription: (await observer.first()) - sent,
      stop: clickedAt === undefined ? [] : [end.at - clickedAt],
      renderGaps: renders
        .slice(1)
        .map(({ at }, index) => at - renders[index].at),
      renderCount: renders.length,
    }
  } finally {
    await Promise.all(turns.map(({ observer }) => observer.close()))
  }
}

export async function runStreamingBrowser(
  deployment: Deployment,
  frontend: string,
  provider: Provider,
  users: User[],
  record: (run: Record<string, unknown>) => void,
) {
  const browser = await chromium.launch()
  try {
    const context = await browser.newContext({
      storageState: users[0].account.state,
      reducedMotion: 'reduce',
      viewport: { width: 1440, height: 900 },
    })
    for (const [mode, count] of [
      ['chromium', 1],
      ['chromium', 8],
      ['chromium-fast', 1],
      ['chromium-fast', 8],
    ] as const) {
      const samples = []
      for (let round = 0; round <= 5; round++) {
        const page = await context.newPage()
        try {
          const sample = await browserBatch(
            page,
            deployment,
            frontend,
            provider,
            users.slice(0, count),
            round,
            mode,
          )
          if (round) samples.push(sample)
        } finally {
          await page.close()
        }
      }
      record({
        workload: mode,
        requestedConcurrency: count,
        warmupBatches: 1,
        peakConcurrencyPerBatch: samples.map(({ peak }) => peak),
        firstRenderedText: latency(samples.map(({ render }) => render)),
        firstChunkToRenderedText: latency(
          samples.map(({ providerToRender }) => providerToRender),
        ),
        firstSubscribedText: latency(
          samples.map(({ subscription }) => subscription),
        ),
        visibleUpdateGap: latency(
          samples.flatMap(({ renderGaps }) => renderGaps),
        ),
        visibleUpdatesPerBatch: samples.map(({ renderCount }) => renderCount),
        stopDisconnect: latency(samples.flatMap(({ stop }) => stop)),
      })
    }
  } finally {
    await browser.close()
  }
}
