import { api } from '@cv/convex/_generated/api'
import { MAX_UNREAD_NOTIFICATIONS } from '@cv/core/limits'
import { ConvexHttpClient } from 'convex/browser'
import { strict as assert } from 'node:assert'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { versions } from '~/scripts/runner/config'

import {
  type SessionId,
  deadline,
  fixtureClient,
  observeInbox,
  withAccounts,
} from './clients'
import { type Deployment, withDeployment } from './deployment'
import {
  type Member,
  installNotificationBatches,
  verifyScheduledDelivery,
} from './notificationBatchExperiment'
import { type Execution, createReport, functionLogs } from './report'
import type * as Fixture from './sharedSendsFixture'
import { summarizeRounds, work } from './sharedSendsReport'

const WARMUPS = 2
const ROUNDS = 12
const SHALLOW_INBOX = 16

type Scenario = {
  name: string
  members: number
  ordinary: number
  protectedCount?: number
  senders?: number
  sessions?: number
  sharedRecipients?: boolean
}

async function withMembers(
  deployment: Deployment,
  execute: (members: Member[]) => Promise<void>,
) {
  await withAccounts(deployment, 16, async (accounts) => {
    const members = accounts.map((account) => {
      const client = new ConvexHttpClient(deployment.url, {
        auth: account.token,
        logger: false,
      })
      return { ...account, client }
    })
    await execute(members)
  })
}

const scenarios: Scenario[] = [
  { name: 'members-1', members: 1, ordinary: MAX_UNREAD_NOTIFICATIONS },
  { name: 'members-4', members: 4, ordinary: MAX_UNREAD_NOTIFICATIONS },
  { name: 'members-16', members: 16, ordinary: MAX_UNREAD_NOTIFICATIONS },
  {
    name: 'protected-100',
    members: 4,
    ordinary: MAX_UNREAD_NOTIFICATIONS,
    protectedCount: 100,
  },
  {
    name: 'protected-500',
    members: 4,
    ordinary: MAX_UNREAD_NOTIFICATIONS,
    protectedCount: 500,
  },
  { name: 'ordinary-empty', members: 4, ordinary: 0 },
  {
    name: 'ordinary-near-capacity',
    members: 4,
    ordinary: MAX_UNREAD_NOTIFICATIONS - 1,
  },
  {
    name: 'concurrent-independent',
    members: 4,
    ordinary: MAX_UNREAD_NOTIFICATIONS,
    sessions: 4,
  },
  {
    name: 'concurrent-overlapping-inboxes',
    members: 4,
    ordinary: MAX_UNREAD_NOTIFICATIONS,
    sessions: 4,
    sharedRecipients: true,
  },
  {
    name: 'concurrent-independent-shallow',
    members: 4,
    ordinary: SHALLOW_INBOX,
    sessions: 4,
  },
  {
    name: 'concurrent-overlapping-inboxes-shallow',
    members: 4,
    ordinary: SHALLOW_INBOX,
    sessions: 4,
    sharedRecipients: true,
  },
]

const activityScenarios: Scenario[] = [
  {
    name: 'concurrent-shared',
    members: 4,
    ordinary: MAX_UNREAD_NOTIFICATIONS,
    senders: 4,
  },
  {
    name: 'concurrent-shared-16-members',
    members: 16,
    ordinary: MAX_UNREAD_NOTIFICATIONS,
    senders: 4,
  },
]

// Modify only the function copy in the disposable deployment.
async function omitMemberActivity(functions: string) {
  const path = join(functions, 'model/messages.ts')
  const source = await readFile(path, 'utf8')
  const loop = [
    '  for (const member of members) {',
    '    await ctx.db.patch(member._id, { lastMessageAt: now })',
    '  }',
    '',
  ].join('\n')
  assert.equal(source.split(loop).length, 2, 'Activity patch loop changed')
  await writeFile(path, source.replace(loop, ''))
}

type Session = { id: SessionId; members: Member[] }
type Mutate = ReturnType<typeof fixtureClient<typeof Fixture>>
type Logs = ReturnType<typeof functionLogs>

async function prepare(
  mutate: Mutate,
  members: Member[],
  scenario: Scenario,
  checkCounts: boolean,
) {
  const sessions: Session[] = []
  for (let i = 0; i < (scenario.sessions ?? 1); i++) {
    const group = scenario.sharedRecipients
      ? [members[i], ...members.slice(-3)]
      : members.slice(i * scenario.members, (i + 1) * scenario.members)
    const userIds = group.map((member) => member.userId)
    const id = await mutate('_session', { userIds })
    sessions.push({ id, members: group })
  }
  const recipients = new Set(
    sessions.flatMap(({ members }) => members.map((member) => member.userId)),
  )
  const seedSessionId = await mutate('_session', { userIds: [...recipients] })
  for (const recipientId of recipients) {
    await mutate('_inbox', {
      recipientId,
      sessionId: seedSessionId,
      ordinary: scenario.ordinary,
      protectedCount: scenario.protectedCount ?? 0,
      resetCount: checkCounts,
    })
  }
  return sessions
}

async function sendRound(sessions: Session[], count: number, ordinal: number) {
  const start = performance.now()
  const sends = await Promise.all(
    sessions.flatMap(({ id, members }) =>
      members.slice(0, count).map(async ({ userId, client }) => {
        const messageId = await client.mutation(api.chat.sendMessage, {
          sessionId: id,
          content: `Performance sample ${ordinal}`,
          silent: true,
        })
        return {
          sessionId: id,
          messageId,
          senderId: userId,
          elapsed: performance.now() - start,
        }
      }),
    ),
  )
  return { sends, start, elapsed: performance.now() - start }
}

type Measurement = {
  checkCounts: boolean
  memberActivity: boolean
  notifications?: 'synchronous' | 'scheduled'
}

type Observers = Map<Member, ReturnType<typeof observeInbox>>

async function measure(
  deployment: Deployment,
  mutate: Mutate,
  logs: Logs,
  sessions: Session[],
  scenario: Scenario,
  mode: Measurement,
) {
  const recipients = new Set(
    sessions.flatMap(({ members }) =>
      members.slice((scenario.senders ?? 1) === 1 ? 1 : 0),
    ),
  )
  const observers = new Map(
    [...recipients].map((member) => [member, observeInbox(deployment, member)]),
  )
  try {
    await deadline(
      Promise.all([...observers.values()].map(({ ready }) => ready)),
      'inbox subscriptions',
    )
    await logs.since()
    return await measureRounds(
      mutate,
      logs,
      sessions,
      scenario,
      observers,
      mode,
    )
  } finally {
    await Promise.all([...observers.values()].map(({ close }) => close()))
  }
}

async function measureRounds(
  mutate: Mutate,
  logs: Logs,
  sessions: Session[],
  scenario: Scenario,
  observers: Observers,
  mode: Measurement,
) {
  const entries: Execution[] = []
  const samples = {
    acknowledgements: [] as number[],
    deliveryTimes: [] as number[],
    deliveryAfterAck: [] as number[],
    sendElapsed: 0,
    settledElapsed: 0,
  }
  let firstSendWork: ReturnType<typeof work> | undefined
  for (let round = -WARMUPS; round < ROUNDS; round++) {
    const result = await sendRound(sessions, scenario.senders ?? 1, round)
    const observations = await observeDeliveries(result, sessions, observers)
    const logged = await logs.since()
    const reset = scenario.ordinary < MAX_UNREAD_NOTIFICATIONS
    await mutate('_verify', {
      sessionIds: sessions.map(({ id }) => id),
      sends: result.sends.map(({ sessionId, messageId, senderId }) => ({
        sessionId,
        messageId,
        senderId,
      })),
      ordinary: scenario.ordinary,
      protectedCount: scenario.protectedCount ?? 0,
      reset,
      checkCounts: mode.checkCounts,
      memberActivity: mode.memberActivity,
    })
    if (reset) await Promise.all(observations.map(({ cleared }) => cleared()))
    await logs.since()
    if (round === -WARMUPS) firstSendWork = work(logged, result.sends.length)
    if (round < 0) continue
    entries.push(...logged)
    samples.sendElapsed += result.elapsed
    samples.acknowledgements.push(...result.sends.map((send) => send.elapsed))
    const delivered = observations.flatMap(({ receipts }) => receipts)
    const times = delivered.map(({ time }) => time - result.start)
    samples.settledElapsed += Math.max(result.elapsed, ...times)
    samples.deliveryTimes.push(...times)
    samples.deliveryAfterAck.push(
      ...delivered.map(({ time, ack }) => time - result.start - ack),
    )
  }
  return {
    ...scenario,
    memberActivity: mode.memberActivity,
    ...summarizeRounds(
      entries,
      samples,
      WARMUPS * (scenario.senders ?? scenario.sessions ?? 1),
      mode.notifications,
    ),
    firstSendWork,
  }
}

async function observeDeliveries(
  { sends }: Awaited<ReturnType<typeof sendRound>>,
  sessions: Session[],
  observers: Observers,
) {
  return Promise.all(
    [...observers].map(async ([member, observer]) => {
      const expected = sends.filter(
        (send) =>
          send.senderId !== member.userId &&
          sessions.some(
            ({ id, members }) =>
              id === send.sessionId && members.includes(member),
          ),
      )
      const ids = expected.map(({ messageId }) => messageId)
      const times = await observer.delivery(ids)
      return {
        receipts: times.map((time, index) => ({
          time,
          ack: expected[index].elapsed,
        })),
        cleared: () => observer.cleared(ids),
      }
    }),
  )
}

async function verifyConcurrentInboxChanges(mutate: Mutate, members: Member[]) {
  const [sender, recipient] = members
  for (const change of ['markRead', 'discardSession'] as const) {
    const userIds = [sender.userId, recipient.userId]
    const seedId = await mutate('_session', { userIds })
    const id = await mutate('_session', { userIds })
    const ordinary = MAX_UNREAD_NOTIFICATIONS - (change === 'markRead' ? 2 : 0)
    await mutate('_inbox', {
      recipientId: recipient.userId,
      sessionId: seedId,
      ordinary,
      protectedCount: 1,
      resetCount: true,
    })
    const sessions = [{ id, members: [sender, recipient] }]
    await sendRound(sessions, 1, -1)
    const inbox = await recipient.client.query(api.notifications.list, {
      status: 'unread',
    })
    const seed = inbox.find((row) => row.sessionId === seedId)
    assert.ok(seed, 'Missing seeded notification for concurrent inbox change')
    const [result] = await Promise.all([
      sendRound(sessions, 1, 0),
      change === 'markRead'
        ? recipient.client.mutation(api.notifications.markRead, {
            notificationId: seed._id,
          })
        : recipient.client.mutation(api.notifications.discardSession, {
            sessionId: seedId,
          }),
    ])
    await mutate('_verifyRace', {
      recipientId: recipient.userId,
      expectedCount: change === 'markRead' ? ordinary + 1 : 2,
      messageId: result.sends[0].messageId,
    })
  }
}

async function measureScenario(
  deployment: Deployment,
  mutate: Mutate,
  logs: Logs,
  members: Member[],
  scenario: Scenario,
  mode: Measurement,
) {
  const sessions = await prepare(mutate, members, scenario, mode.checkCounts)
  await Promise.all(
    sessions.flatMap(({ members }) =>
      members.slice(0, scenario.senders ?? 1).map(async (member) => {
        member.client.setAuth(await member.refreshToken())
      }),
    ),
  )
  return measure(deployment, mutate, logs, sessions, scenario, mode)
}

async function runScenarios(
  cases: Scenario[],
  mode: Measurement,
  record: ReturnType<typeof createReport>['record'],
) {
  await withDeployment(
    async (deployment) => {
      const mutate = fixtureClient<typeof Fixture>(
        deployment,
        'sharedSendsFixture',
      )
      const logs = functionLogs(deployment)
      await withMembers(deployment, async (members) => {
        let fullInboxReads = 0
        for (const scenario of cases) {
          const result = await measureScenario(
            deployment,
            mutate,
            logs,
            members,
            scenario,
            mode,
          )
          record(result)
          if (!mode.checkCounts) continue
          const reads = result.work.databaseReadDocuments.max
          assert.ok(
            reads <= 20 + 6 * scenario.members,
            'Send exceeded bounded inbox reads',
          )
          if (scenario.name === 'members-4') fullInboxReads = reads
          if (scenario.protectedCount) {
            assert.equal(
              reads,
              fullInboxReads,
              'Protected requests increased send reads',
            )
          }
        }
        if (mode.notifications === 'scheduled') {
          await verifyScheduledDelivery(deployment, members)
        } else if (mode.checkCounts && mode.memberActivity) {
          for (const member of members.slice(0, 2)) {
            member.client.setAuth(await member.refreshToken())
          }
          await verifyConcurrentInboxChanges(mutate, members)
        }
      })
    },
    'sharedSendsFixture',
    mode.notifications === 'scheduled'
      ? installNotificationBatches
      : mode.memberActivity
        ? undefined
        : omitMemberActivity,
  )
}

export async function runSharedSends() {
  const recipientBatches = process.argv.includes('--recipient-batches')
  const baseline = process.argv.includes('--baseline')
  const batches = process.argv.includes('--notification-batches')
  assert.ok(
    [baseline, batches, recipientBatches].filter(Boolean).length <= 1,
    'Choose one shared-send comparison',
  )
  if (recipientBatches) {
    const { runRecipientBatches } = await import('./recipientBatchExperiment')
    return runRecipientBatches()
  }
  const suite = batches
    ? 'shared-sends-notification-batches'
    : baseline
      ? 'shared-sends-baseline'
      : 'shared-sends'
  const { record, writeReport } = createReport(suite, {
    convex: versions.convexBackend,
  })
  try {
    if (batches) {
      const cases = scenarios.filter(({ sessions }) => sessions === 4)
      for (const notifications of ['synchronous', 'scheduled'] as const) {
        await runScenarios(
          cases,
          { checkCounts: true, memberActivity: true, notifications },
          record,
        )
      }
      await writeReport()
      return
    }
    await runScenarios(
      [...scenarios, ...activityScenarios],
      {
        checkCounts: !baseline,
        memberActivity: true,
      },
      record,
    )
    if (!baseline) {
      await runScenarios(
        activityScenarios,
        {
          checkCounts: true,
          memberActivity: false,
        },
        record,
      )
    }
    await writeReport()
  } catch (error) {
    await writeReport(error)
    throw error
  }
}
