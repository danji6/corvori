import type { Id } from '@cv/convex/_generated/dataModel'
import { strict as assert } from 'node:assert'
import { versions } from '~/scripts/runner/config'

import {
  type Account,
  type SessionId,
  fixtureClient,
  observe,
  withAccounts,
} from './clients'
import {
  type Deployment,
  withBrowserClient,
  withDeployment,
} from './deployment'
import { createReport, functionLogs, queryWork, timings } from './report'
import { browserScenario } from './sidebarBrowser'

const { record, writeReport } = createReport('sidebar', {
  convex: versions.convexBackend,
})

const VIEWERS = 32
const WARMUPS = 4
const SAMPLES = 40
const SCOPED = 'streams:activeSessionIdsForSessions'
type Logs = ReturnType<typeof functionLogs>
type Viewer = ReturnType<typeof observe>

async function run(
  deployment: Deployment,
  accounts: Account[],
  frontend: string,
) {
  const mutate = fixtureClient(deployment)
  const fixture = await mutate('_seed', {
    viewerIds: accounts.map(({ userId }) => userId),
  })
  const sessions = fixture.privateIds
  const ownerInput = { invokedBy: fixture.ownerId, agentId: fixture.agentId }
  const start = (ids: typeof sessions) =>
    mutate('_start', { ...ownerInput, sessionIds: ids })
  const stop = (ids: Awaited<ReturnType<typeof start>>) =>
    mutate('_updateOrStop', { streamIds: ids, stop: true })
  const logs = functionLogs(deployment)
  const background = await start(sessions.slice(1))
  const deps = { deployment, accounts, sessions, start, stop, logs }

  for (const viewers of [1, 8, 32, 1]) {
    for (const mode of ['baseline', 'scoped'] as const) {
      await subscriptionScenario(deps, viewers, 128, mode)
    }
  }
  await unrelatedScenario(deps, background.slice(-1))
  await stop(background)
  const small = await start(sessions.slice(1, 8))
  await subscriptionScenario(deps, 8, 8, 'scoped')
  await stop(small)
  await sharedScenario(deps)
  const browserBackground = await start(sessions.slice(1))
  const browserLoad = accounts
    .slice(1)
    .map((account, index) =>
      observe(deployment, account, [sessions[index + 1]]),
    )
  try {
    await Promise.all(
      browserLoad.map((viewer) =>
        viewer.waitFor((value) => value.length === 1),
      ),
    )
    await browserScenario({
      record,
      ...deps,
      extraIds: fixture.extraIds,
      frontend,
      backgroundViewers: browserLoad.length,
    })
  } finally {
    await Promise.all(browserLoad.map((viewer) => viewer.close()))
    await stop(browserBackground)
  }
}

type Scenario = {
  deployment: Deployment
  accounts: Account[]
  sessions: SessionId[]
  start: (ids: SessionId[]) => Promise<Id<'streams'>[]>
  stop: (ids: Id<'streams'>[]) => Promise<unknown>
  logs: Logs
}

async function subscriptionScenario(
  { deployment, accounts, sessions, start, stop, logs }: Scenario,
  viewers: number,
  streams: number,
  mode: 'baseline' | 'scoped',
) {
  const clients = accounts
    .slice(0, viewers)
    .map((account, index) =>
      observe(deployment, account, [sessions[index]], mode),
    )
  try {
    await Promise.all(
      clients.map(async (client, index) => {
        const expected = index === 0 ? [] : [sessions[index]]
        assert.deepEqual(await client.waitFor(() => true), expected)
      }),
    )
    const owner = clients[0]
    const toggle = async (
      on: boolean,
      ids: Awaited<ReturnType<typeof start>>,
    ) => {
      const begin = performance.now()
      const changed = owner
        .waitFor((value) => value.includes(sessions[0]) === on)
        .then((value) => {
          assert.deepEqual(value, on ? [sessions[0]] : [])
          return performance.now() - begin
        })
      const operation = on ? start([sessions[0]]) : stop(ids).then(() => [])
      const [elapsed, streamIds] = await Promise.all([changed, operation])
      return { streamIds, elapsed }
    }
    let ids: Awaited<ReturnType<typeof start>> = []
    for (let i = 0; i < WARMUPS; i++) {
      ids = (await toggle(i % 2 === 0, ids)).streamIds
    }
    await logs.since()
    const samples = []
    const entries: Awaited<ReturnType<Logs['since']>> = []
    let drain = Promise.resolve()
    const begin = performance.now()
    for (let i = 0; i < SAMPLES; i++) {
      const result = await toggle(i % 2 === 0, ids)
      ids = result.streamIds
      samples.push(result.elapsed)
      // The backend retains only a bounded log window. Drain it during the run.
      if ((i + 1) % 8 === 0) {
        drain = drain.then(async () => {
          entries.push(...(await logs.since()))
        })
        void drain.catch(() => {})
      }
    }
    const elapsed = performance.now() - begin
    const identifier = mode === 'scoped' ? SCOPED : 'sidebarFixture:baseline'
    await drain
    entries.push(...(await logs.since()))
    const work = queryWork(entries, identifier)
    record({
      scenario: 'private',
      viewers,
      streams,
      mode,
      subscription: timings(samples, elapsed, WARMUPS),
      query: work,
    })
    assert.ok(work.executions > 0, `Missing execution logs for ${identifier}`)
    if (mode === 'scoped')
      assert.ok(
        work.maxDocuments <= 3,
        'A single visible session read more than user, membership and stream',
      )
  } finally {
    await Promise.all(clients.map((client) => client.close()))
  }
}

async function unrelatedScenario(
  { deployment, accounts, sessions, start, stop, logs }: Scenario,
  existing: Awaited<ReturnType<Scenario['start']>>,
) {
  const clients = accounts.map((account, index) =>
    observe(deployment, account, [sessions[index]]),
  )
  try {
    await Promise.all(clients.map((client) => client.waitFor(() => true)))
    await logs.since()
    const mutate = fixtureClient(deployment)
    const created = await start([sessions.at(-1)!])
    await mutate('_updateOrStop', {
      streamIds: [...existing, ...created],
      stop: false,
    })
    await stop(created)
    // Subscribe after the writes to prove the WebSocket has caught up with the backend.
    const barrier = observe(deployment, accounts[0], [
      sessions[0],
      sessions.at(-1)!,
    ])
    try {
      assert.deepEqual(await barrier.waitFor(() => true), [])
    } finally {
      await barrier.close()
    }
    const entries = await logs.since()
    const work = queryWork(entries, SCOPED)
    record({
      scenario: 'unrelated',
      viewers: clients.length,
      writes: 4,
      barrierExecutions: 1,
      query: work,
    })
    assert.equal(
      work.executions,
      1,
      'Unrelated writes re-executed an existing sidebar subscription',
    )
  } finally {
    await Promise.all(clients.map((client) => client.close()))
  }
}

async function sharedScenario({
  deployment,
  accounts,
  sessions,
  start,
  stop,
}: Scenario) {
  const mutate = fixtureClient(deployment)
  const sessionId = sessions[0]
  const userId = accounts[1].userId
  const share = (enabled: boolean) =>
    mutate('_share', { sessionId, userId, share: enabled })
  await share(true)
  const clients: Viewer[] = [accounts[0], accounts[1], accounts[1]].map(
    (account) => observe(deployment, account, [sessionId]),
  )
  const expectStatus = async (viewers: Viewer[], active: boolean) => {
    await Promise.all(
      viewers.map((client) =>
        client.waitFor((value) => value.includes(sessionId) === active),
      ),
    )
  }
  try {
    await expectStatus(clients, false)
    const [first, second] = await start([sessionId, sessionId])
    await expectStatus(clients, true)
    await stop([first])
    await clients[2].close()
    clients[2] = observe(deployment, accounts[1], [sessionId])
    await expectStatus(clients, true)
    await share(false)
    await expectStatus(clients.slice(1), false)
    await stop([second])
    await expectStatus(clients, false)
    record({
      scenario: 'shared',
      members: 2,
      tabs: clients.length,
      reconnects: 1,
      revocations: 1,
    })
  } finally {
    await Promise.all(clients.map((client) => client.close()))
  }
}

async function main() {
  await withDeployment(async (deployment) => {
    await withBrowserClient(deployment, (frontend) =>
      withAccounts(deployment, VIEWERS, (accounts) =>
        run(deployment, accounts, frontend),
      ),
    )
  })
}

export type { Scenario }

export async function runSidebar() {
  try {
    await main()
    await writeReport()
  } catch (error) {
    await writeReport(error)
    throw error
  }
}
