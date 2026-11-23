import { APP_ID } from '@cv/core/const'
import { type Page, chromium, expect } from '@playwright/test'
import { strict as assert } from 'node:assert'
import { versions } from '~/scripts/runner/config'

import { type Provider, type User, makeUsers } from './activeStreaming'
import { observeTurn, verifyText } from './activeStreamingObserver'
import { startProvider, streamScript } from './activeStreamingProvider'
import { intervalsFor, overlap } from './activeStreamingReport'
import { type SessionId, withAccounts } from './clients'
import {
  type Deployment,
  withBrowserClient,
  withDeployment,
} from './deployment'
import {
  type MemorySnapshot,
  memoryProbe,
  memorySampleIntervalMs,
  sampleWhile,
} from './memoryProcesses'
import {
  checkpointWorkload,
  createMemoryWorkspaces,
  memoryWorkspaceSize,
  withMemorySidecar,
} from './memorySidecar'
import { createReport } from './report'

const sessionCount = 4
const warmups = 2
const cycles = 12
const settleMs = 1_500
const finalIdleMs = 10_000
// The client query cache retains idle entries for five minutes by default.
const postCacheIdleMs = 305_000
const assistantText = '[data-role="assistant"] .chat-markdown'

type MemoryCycle = {
  deployment: Deployment
  page: Page
  provider: Provider
  users: User[]
  workspaces: Awaited<ReturnType<typeof createMemoryWorkspaces>>
  beginCheckpoint: ReturnType<typeof checkpointWorkload>
}

async function openChat(page: Page, title: string, id: SessionId) {
  const recents = page.locator('[data-session-page="recents"]')
  await recents.getByRole('button', { name: title }).click()
  await page.waitForURL((url) => url.searchParams.get('id') === id)
  await expect(page.locator('[contenteditable="true"]').first()).toBeEditable()
}

async function closeChat(page: Page) {
  await page.getByRole('button', { name: 'New Session', exact: true }).click()
  await page.waitForURL((url) => !url.searchParams.has('id'))
  await expect(page.locator(assistantText)).toHaveCount(0)
}

async function sendFromComposer(page: Page, marker: string) {
  await page
    .locator('[contenteditable="true"]')
    .first()
    .fill(`Write the numbered script for ${marker}`)
  await page.getByRole('button', { name: 'Send', exact: true }).click()
}

async function makeTurns({ deployment, users }: MemoryCycle, index: number) {
  const titles = users.map((_, user) => `Memory session ${index}-${user}`)
  const ids = await Promise.all(
    users.map(async ({ account, session }, user) => {
      account.token = await account.refreshToken()
      return session(titles[user])
    }),
  )
  return ids.map((id, user) => {
    const script = streamScript(user, `memory-${index}-${user}`, 'fast')
    return {
      id,
      title: titles[user],
      script,
      observer: observeTurn(deployment, users[user].account, id, script),
    }
  })
}

type MemoryTurn = Awaited<ReturnType<typeof makeTurns>>[number]

async function finishTurn({ observer, script }: MemoryTurn) {
  const [final, end] = await Promise.all([observer.final(), script.ended()])
  assert.equal(end.kind, 'finished')
  assert.ok(final.text)
  verifyText(script, observer.updates, final.text, false)
  return final.text
}

async function runCycle(input: MemoryCycle, index: number) {
  const { page, provider, workspaces, beginCheckpoint } = input
  const turns = await makeTurns(input, index)
  const [foreground, ...background] = turns
  try {
    await openChat(page, foreground.title, foreground.id)
    await Promise.all(turns.map(({ observer }) => observer.ready()))
    const checkpoints = await Promise.all(
      turns.map(({ id }, i) => beginCheckpoint(id, workspaces[i])),
    )
    turns.forEach(({ script }) => provider.schedule(script))
    await Promise.all([
      sendFromComposer(page, foreground.script.marker),
      ...background.map(({ observer }) => observer.send()),
    ])
    const [answer] = await Promise.all(turns.map(finishTurn))
    await Promise.all(checkpoints.map((finish) => finish()))
    await expect(page.locator(assistantText)).toHaveText(answer)
    provider.verify()
    await closeChat(page)
    return overlap(await intervalsFor(turns.map(({ script }) => script)))
  } finally {
    await Promise.all(turns.map(({ observer }) => observer.close()))
  }
}

type Probe = Awaited<ReturnType<typeof memoryProbe>>
type RecordRun = (run: Record<string, unknown>) => void

async function profileCycles(
  input: MemoryCycle,
  probe: Probe,
  record: RecordRun,
) {
  for (let i = 0; i < warmups; i++) {
    console.log(`Warming up memory cycle ${i + 1}/${warmups}`)
    await runCycle(input, i)
  }
  await Bun.sleep(settleMs)
  const warm = await probe.sample(true)
  record({ phase: 'after-warmup', memory: warm })
  const timeOrigin = await input.page.evaluate(() => performance.timeOrigin)
  for (let i = 0; i < cycles; i++) {
    console.log(`Measuring memory cycle ${i + 1}/${cycles}`)
    await profileCycle(input, probe, record, i)
  }

  await Bun.sleep(finalIdleMs)
  await recordIdle(probe, record, warm, 'after-final-idle')
  console.log('Waiting for the idle client query cache to expire')
  await Bun.sleep(postCacheIdleMs - finalIdleMs)
  assert.equal(
    await input.page.evaluate(() => performance.timeOrigin),
    timeOrigin,
  )
  await recordIdle(probe, record, warm, 'after-cache-expiry')
}

async function recordIdle(
  probe: Probe,
  record: RecordRun,
  warm: MemorySnapshot,
  phase: 'after-final-idle' | 'after-cache-expiry',
) {
  const final = await probe.sample(true)
  const delta = Object.fromEntries(
    (Object.keys(final) as (keyof MemorySnapshot)[]).map((key) => [
      key,
      final[key] - warm[key],
    ]),
  )
  record({ phase, memory: final, deltaFromWarmup: delta })
}

async function profileCycle(
  input: MemoryCycle,
  probe: Probe,
  record: RecordRun,
  index: number,
) {
  const { peak, samples, result } = await sampleWhile(probe, () =>
    runCycle(input, index + warmups),
  )
  await Bun.sleep(settleMs)
  record({
    phase: 'cycle',
    cycle: index + 1,
    peakConcurrency: result,
    activeSamples: samples,
    sampledPeak: peak,
    settled: await probe.sample(true),
  })
}

async function withMemoryPage(
  frontend: string,
  user: User,
  execute: (
    browser: Awaited<ReturnType<typeof chromium.launch>>,
    page: Page,
  ) => Promise<void>,
) {
  const browser = await chromium.launch()
  try {
    const context = await browser.newContext({
      storageState: user.account.state,
      viewport: { width: 1440, height: 900 },
      reducedMotion: 'reduce',
    })
    await context.addInitScript((storageKey) => {
      localStorage.setItem(
        storageKey,
        JSON.stringify({
          sidebar: { left: { collapsed: false, pinned: true } },
        }),
      )
    }, `${APP_ID}-ui-settings:${user.account.userId}`)
    const page = await context.newPage()
    page.setDefaultTimeout(20_000)
    await page.goto(frontend)
    await expect(
      page.getByRole('button', { name: 'New Session', exact: true }),
    ).toBeVisible()
    await execute(browser, page)
  } finally {
    await browser.close()
  }
}

async function profileDeployment(
  deployment: Deployment,
  provider: Provider,
  record: RecordRun,
) {
  await withAccounts(deployment, sessionCount, async (accounts) => {
    const users = await makeUsers(deployment, accounts, provider)
    const workspaces = await createMemoryWorkspaces(
      deployment.dir,
      sessionCount,
    )
    await withMemorySidecar(deployment, (sidecar) =>
      withBrowserClient(deployment, (frontend) =>
        withMemoryPage(frontend, users[0], async (browser, page) => {
          const probe = await memoryProbe(
            browser,
            page,
            deployment.backendPid,
            sidecar.pid,
          )
          await profileCycles(
            {
              deployment,
              page,
              provider,
              users,
              workspaces,
              beginCheckpoint: checkpointWorkload(sidecar),
            },
            probe,
            record,
          )
        }),
      ),
    )
  })
}

export async function runMemoryUsage() {
  const { record, writeReport } = createReport('memory', {
    convex: versions.convexBackend,
    warmups,
    cycles,
    sessionCount,
    settleMs,
    finalIdleMs,
    postCacheIdleMs,
    activeSampleIntervalMs: memorySampleIntervalMs,
    ...memoryWorkspaceSize,
  })
  const provider = await startProvider()
  try {
    await withDeployment(
      (deployment) => profileDeployment(deployment, provider, record),
      'activeStreamingFixture',
    )
    await writeReport()
  } catch (error) {
    await writeReport(error)
    throw error
  } finally {
    provider.close()
  }
}
