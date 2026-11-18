import { STREAM_PATCH_INTERVAL_MS } from '@cv/core/const'
import { strict as assert } from 'node:assert'
import { versions } from '~/scripts/runner/config'

import { runStreamingBrowser } from './activeStreamingBrowser'
import type * as Fixture from './activeStreamingFixture'
import { observeTurn, verifyText } from './activeStreamingObserver'
import {
  type Script,
  type Workload,
  now,
  startProvider,
  streamScript,
  workloads,
} from './activeStreamingProvider'
import {
  completedBatch,
  intervalsFor,
  latency,
  overlap,
  streamWork,
} from './activeStreamingReport'
import {
  type Account,
  type SessionId,
  fixtureClient,
  withAccounts,
} from './clients'
import {
  type Deployment,
  withBrowserClient,
  withDeployment,
} from './deployment'
import { createReport, functionLogs } from './report'

const WARMUPS = 1
const SAMPLES = 5
const concurrency = [1, 4, 8]
export type Provider = Awaited<ReturnType<typeof startProvider>>
type Observer = ReturnType<typeof observeTurn>
type Logs = ReturnType<typeof functionLogs>

export type User = {
  account: Account
  session: (title?: string) => Promise<SessionId>
}

export function makeUsers(
  deployment: Deployment,
  accounts: Account[],
  provider: Provider,
) {
  const fixture = fixtureClient<typeof Fixture>(
    deployment,
    'activeStreamingFixture',
  )
  return Promise.all(
    accounts.map(async (account, index) => {
      const ownerId = account.userId
      const providerArgs = await fixture('_provider', {
        ownerId,
        baseURL: `${provider.url}/${index}`,
      })
      return {
        account,
        session: (title?: string) =>
          fixture('_session', { ownerId, ...providerArgs, title }),
      }
    }),
  )
}

async function executeTurn(observer: Observer, script: Script) {
  const stop =
    script.workload === 'quiet-stop' || script.workload === 'fast-stop'
  const sent = await observer.send()
  const providerStarted = await script.started()
  const stopped = stop
    ? await stopTurn(observer, script, providerStarted)
    : undefined
  const [final, end] = await Promise.all([observer.final(), script.ended()])
  verifyText(script, observer.updates, final.text, stop)
  assert.equal(
    end.kind,
    stop ? 'disconnected' : 'finished',
    `Unexpected provider termination for ${script.marker}`,
  )
  if (stopped)
    assert.equal(
      final.text,
      stopped.text,
      `Persisted text changed after Stop for ${script.marker}`,
    )
  if (script.workload !== 'quiet-stop')
    assert.ok(observer.updates.length, 'Missing assistant text')

  const updated = observer.updates
  let length = 0
  const chunkDelivery = script.chunks.flatMap(({ at, text }) => {
    length += text.length
    const seen = updated.find((update) => update.text.length >= length)
    return seen ? [seen.at - at] : []
  })
  return {
    startDelay: providerStarted - sent,
    firstText: script.chunks.length ? [(await observer.first()) - sent] : [],
    firstChunkToText: script.chunks.length
      ? [(await observer.first()) - script.chunks[0].at]
      : [],
    updateGap: updated.slice(1).map(({ at }, index) => at - updated[index].at),
    chunkDelivery,
    duration: final.at - sent,
    stopAck: stopped ? [stopped.acknowledgedAt - stopped.at] : [],
    stopDisconnect: stopped ? [end.at - stopped.at] : [],
    chunks: script.chunks.length,
    emittedBytes: script.chunks.reduce(
      (total, { text }) => total + Buffer.byteLength(text),
      0,
    ),
    stoppedText: stopped?.text,
  }
}

async function stopTurn(
  observer: Observer,
  script: Script,
  providerStarted: number,
) {
  if (script.workload === 'quiet-stop') {
    await Bun.sleep(Math.max(0, providerStarted + 2000 - now()))
  } else {
    await observer.first()
  }
  return observer.stop()
}

async function runBatch(
  deployment: Deployment,
  logs: Logs,
  provider: Provider,
  users: User[],
  workload: Workload,
  marker: string,
) {
  const sessionIds = await Promise.all(users.map(({ session }) => session()))
  const turns = users.map(({ account }, index) => {
    const script = streamScript(
      index,
      `${marker}-${index}`,
      workload === 'fast-stop' && index > 0 ? 'fast' : workload,
    )
    return {
      script,
      observer: observeTurn(deployment, account, sessionIds[index], script),
    }
  })
  try {
    await Promise.all(turns.map(({ observer }) => observer.ready()))
    await logs.since()
    turns.forEach(({ script }) => provider.schedule(script))
    const samples = await Promise.all(
      turns.map(({ observer, script }) => executeTurn(observer, script)),
    )
    const entries = await completedBatch(logs, turns.length)
    await Promise.all(
      turns.map(async ({ observer, script }, index) => {
        const { stoppedText } = samples[index]
        if (stoppedText === undefined) return
        assert.equal(
          await observer.persistedText(),
          stoppedText,
          `Persisted text changed after the stream action exited for ${script.marker}`,
        )
      }),
    )
    const intervals = await intervalsFor(turns.map(({ script }) => script))
    provider.verify()
    return { samples, entries, intervals }
  } finally {
    await Promise.all(turns.map(({ observer }) => observer.close()))
  }
}

async function measure(
  deployment: Deployment,
  logs: Logs,
  provider: Provider,
  users: User[],
  workload: Workload,
  record: (run: Record<string, unknown>) => void,
) {
  const batches = []
  for (let round = -WARMUPS; round < SAMPLES; round++) {
    const marker = `bench-${workload}-${users.length}-${round + WARMUPS}`
    const result = await runBatch(
      deployment,
      logs,
      provider,
      users,
      workload,
      marker,
    )
    if (round >= 0) batches.push(result)
  }
  const samples = batches.flatMap((batch) => batch.samples)
  const intervals = batches.flatMap((batch) => batch.intervals)
  const seconds = intervals.reduce(
    (total, { start, end }) => total + (end - start) / 1000,
    0,
  )
  const work = streamWork(
    batches.flatMap(({ entries }) => entries),
    seconds,
  )
  const chunks = samples.reduce((total, sample) => total + sample.chunks, 0)
  record({
    workload,
    requestedConcurrency: users.length,
    warmupBatches: WARMUPS,
    measuredBatches: SAMPLES,
    peakConcurrencyPerBatch: batches.map(({ intervals }) => overlap(intervals)),
    emittedChunks: chunks,
    emittedTextBytes: samples.reduce(
      (total, sample) => total + sample.emittedBytes,
      0,
    ),
    providerStart: latency(samples.map(({ startDelay }) => startDelay)),
    firstClientText: latency(samples.flatMap(({ firstText }) => firstText)),
    firstChunkToClientText: latency(
      samples.flatMap(({ firstChunkToText }) => firstChunkToText),
    ),
    clientUpdateGap: latency(samples.flatMap(({ updateGap }) => updateGap)),
    chunkToClientText: latency(
      samples.flatMap(({ chunkDelivery }) => chunkDelivery),
    ),
    turnDuration: latency(samples.map(({ duration }) => duration)),
    stopAcknowledgement: latency(samples.flatMap(({ stopAck }) => stopAck)),
    stopDisconnect: latency(
      samples.flatMap(({ stopDisconnect }) => stopDisconnect),
    ),
    work,
  })
  if (workload === 'fast')
    assert.ok(
      work.partialPatches.calls > 0 && work.partialPatches.calls < chunks,
      'Expected fast provider chunks to be combined into fewer patches',
    )
}

async function refreshAccounts(users: User[]) {
  await Promise.all(
    users.map(async ({ account }) => {
      account.token = await account.refreshToken()
    }),
  )
}

export async function runActiveStreaming() {
  const { record, writeReport } = createReport('active-streaming', {
    convex: versions.convexBackend,
    patchIntervalMs: STREAM_PATCH_INTERVAL_MS,
  })
  const provider = await startProvider()
  try {
    await withDeployment(async (deployment) => {
      const logs = functionLogs(deployment)
      await withAccounts(
        deployment,
        Math.max(...concurrency),
        async (accounts) => {
          const users = await makeUsers(deployment, accounts, provider)
          for (const count of concurrency) {
            for (const workload of workloads) {
              await refreshAccounts(users.slice(0, count))
              console.log(`Measuring ${workload} with ${count} streams`)
              await measure(
                deployment,
                logs,
                provider,
                users.slice(0, count),
                workload,
                record,
              )
            }
          }
          await refreshAccounts(users)
          await withBrowserClient(deployment, (frontend) =>
            runStreamingBrowser(deployment, frontend, provider, users, record),
          )
        },
      )
    }, 'activeStreamingFixture')
    await writeReport()
  } catch (error) {
    await writeReport(error)
    throw error
  } finally {
    provider.close()
  }
}
