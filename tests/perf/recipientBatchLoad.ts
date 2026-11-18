import { api } from '@cv/convex/_generated/api'
import type { Id } from '@cv/convex/_generated/dataModel'
import { MAX_UNREAD_NOTIFICATIONS } from '@cv/core/limits'
import { ConvexHttpClient } from 'convex/browser'
import { strict as assert } from 'node:assert'

import { type Account, deadline, fixtureClient, observeInbox } from './clients'
import type { Deployment } from './deployment'
import { type Variant, latency, recipientWork } from './recipientBatchReport'
import { type Execution, functionLogs } from './report'
import type * as Fixture from './sharedSendsFixture'

type Member = Account & { client: ConvexHttpClient }
type FixtureClient = ReturnType<typeof fixtureClient<typeof Fixture>>
type Session = { id: Id<'sessions'>; sender: Member; recipients: Member[] }
type Sent = {
  id: Id<'messages'>
  session: Session
  dispatched: number
  acknowledged: number
}
type Sample = {
  sent: Sent[]
  errors: string[]
  start: number
  dispatchLag: number[]
}

type Workload = {
  name: string
  chats: number
  overlap: boolean
  ordinary: number
  rate?: number
}
const depth = MAX_UNREAD_NOTIFICATIONS
const sustainedSeconds = 30
const warmups = 2
const rounds = 12
const requestTimeoutMs = 20_000

const boundedFetch = Object.assign(
  (input: RequestInfo | URL, options?: RequestInit) =>
    fetch(input, {
      ...options,
      signal: AbortSignal.timeout(requestTimeoutMs),
    }),
  { preconnect: fetch.preconnect },
)

export const workloads: Workload[] = [
  { name: 'idle', chats: 1, overlap: false, ordinary: 16 },
  ...[false, true].flatMap((overlap) => {
    const group = overlap ? 'overlap' : 'distinct'
    return [
      ...[16, depth].map((ordinary) => ({
        name: `burst-${group}-${ordinary}`,
        chats: 4,
        overlap,
        ordinary,
      })),
      ...[4, 8, 16].map((rate) => ({
        name: `sustained-${group}-${rate}`,
        chats: 4,
        overlap,
        ordinary: depth,
        rate,
      })),
    ]
  }),
]

export async function createMembers(
  deployment: Deployment,
  accounts: Account[],
) {
  return Promise.all(
    accounts.map(async (account) => ({
      ...account,
      client: new ConvexHttpClient(deployment.url, {
        auth: await account.refreshToken(),
        logger: false,
        fetch: boundedFetch,
      }),
    })),
  )
}

async function setup(
  mutate: FixtureClient,
  accounts: Member[],
  workload: Workload,
) {
  const sessions: Session[] = []
  for (let index = 0; index < workload.chats; index++) {
    const [sender, ...distinct] = accounts.slice(index * 4, index * 4 + 4)
    const recipients = workload.overlap ? accounts.slice(-3) : distinct
    const id = await mutate('_session', {
      userIds: [sender, ...recipients].map(({ userId }) => userId),
    })
    sessions.push({ id, sender, recipients })
  }
  const recipients = [
    ...new Set(sessions.flatMap((session) => session.recipients)),
  ]
  const warmed = [
    ...new Set([...recipients, ...sessions.map(({ sender }) => sender)]),
  ]
  const seedId = await mutate('_session', {
    userIds: warmed.map(({ userId }) => userId),
  })
  for (const { userId } of warmed) {
    await mutate('_inbox', {
      recipientId: userId,
      sessionId: seedId,
      ordinary: workload.ordinary,
      protectedCount: 0,
      resetCount: true,
    })
  }
  return { sessions, recipients }
}

export function send(
  client: ConvexHttpClient,
  sessionId: Id<'sessions'>,
  content: string,
) {
  return deadline(
    client.mutation(
      api.chat.sendMessage,
      { sessionId, content, silent: true },
      { skipQueue: true },
    ),
    'send acknowledgement',
    requestTimeoutMs + 1_000,
  )
}

async function issue(
  sessions: Session[],
  ordinal: number,
  rate?: number,
): Promise<Sample> {
  const start = performance.now()
  const requests: Promise<Sent>[] = []
  const dispatchLag: number[] = []
  const count = rate ? rate * sustainedSeconds : sessions.length
  for (let index = 0; index < count; index++) {
    const due = start + (rate ? (index * 1_000) / rate : 0)
    const remaining = due - performance.now()
    if (remaining > 0) await Bun.sleep(remaining)
    const session = sessions[index % sessions.length]
    const dispatched = performance.now()
    dispatchLag.push(dispatched - due)
    requests.push(
      send(
        session.sender.client,
        session.id,
        `Recipient batching ${ordinal} / ${index}`,
      ).then((id) => ({
        id,
        session,
        dispatched,
        acknowledged: performance.now(),
      })),
    )
    // Attach a handler now, even though the driver continues to issue sends.
    void requests.at(-1)!.catch(() => {})
  }
  const results = await Promise.allSettled(requests)
  return {
    sent: results.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    ),
    errors: results.flatMap((result) =>
      result.status === 'rejected' ? [summarizeFailure(result.reason)] : [],
    ),
    start,
    dispatchLag,
  }
}

function summarizeFailure(reason: unknown) {
  const message = String(reason)
  if (message.includes('OptimisticConcurrencyControlFailure')) {
    const table = /the [^a-zA-Z]*(\w+)[^a-zA-Z]* table/.exec(message)?.[1]
    return table
      ? `Send exhausted transaction retries on ${table}`
      : 'Send exhausted transaction retries'
  }
  return message.split('\n')[0]
}

async function collect(
  logs: ReturnType<typeof functionLogs>,
  measure: () => Promise<void>,
) {
  const entries: Execution[] = []
  let done = false
  const record = async () => {
    while (!done) entries.push(...(await logs.since(250)))
    entries.push(...(await logs.since(250)))
  }
  const collection = record()
  void collection.catch(() => {})
  try {
    await measure()
  } finally {
    done = true
    await collection
  }
  return entries
}

type Observer = ReturnType<typeof observeInbox>
type Observations = Map<Member, Observer>

async function observe(sample: Sample, observers: Observations) {
  const expected = sample.sent.flatMap((send) =>
    send.session.recipients.map((recipient) => ({
      send,
      observer: observers.get(recipient)!,
    })),
  )
  await Promise.all(
    [...observers].map(async ([recipient, observer]) => {
      const ids = sample.sent
        .filter(({ session }) => session.recipients.includes(recipient))
        .map(({ id }) => id)
      await observer.delivery(ids, 8_000).catch((error: unknown) => {
        if (
          error instanceof Error &&
          error.message === 'Timed out waiting for notification delivery'
        )
          return
        throw error
      })
    }),
  )
  const receipts = expected.flatMap(({ send, observer }) => {
    const time = observer.receipt(send.id)
    return time === undefined ? [] : [{ time, delay: time - send.dispatched }]
  })
  const acknowledged = sample.sent.map((send) => send.acknowledged)
  const settledAt = Math.max(
    sample.start,
    ...acknowledged,
    ...receipts.map(({ time }) => time),
  )
  return {
    receipts,
    missing: expected.length - receipts.length,
    settledMs: settledAt - sample.start,
    issueMs:
      sample.dispatchLag.length > 1
        ? sample.sent.reduce(
            (last, send) => Math.max(last, send.dispatched - sample.start),
            0,
          )
        : 0,
  }
}

async function verify(
  mutate: FixtureClient,
  sample: Sample,
  sessions: Session[],
  observers: Observations,
  workload: Workload,
) {
  if (!workload.rate && workload.ordinary < depth) {
    await mutate('_verify', {
      sessionIds: sessions.map(({ id }) => id),
      sends: sample.sent.map(({ session, id }) => ({
        sessionId: session.id,
        messageId: id,
        senderId: session.sender.userId,
      })),
      ordinary: workload.ordinary,
      protectedCount: 0,
      reset: true,
      checkCounts: true,
      memberActivity: true,
    })
    await Promise.all(
      [...observers.values()].map((observer) =>
        observer.cleared(sample.sent.map(({ id }) => id)),
      ),
    )
    return
  }
  const messages = await mutate('_inspectMessages', {
    sessionIds: sessions.map(({ id }) => id),
  })
  const time = new Map(
    messages.map(({ _id, _creationTime }) => [_id, _creationTime]),
  )
  const checked = new Set([
    ...observers.keys(),
    ...sessions.map(({ sender }) => sender),
  ])
  for (const member of checked) {
    const { rows, count } = await mutate('_inspectInbox', {
      recipientId: member.userId,
    })
    if (!observers.has(member)) {
      // This account may have retained fixtures from earlier workloads.
      assert.ok(
        rows.every(
          ({ sourceMessageId }) =>
            !sample.sent.some(({ id }) => id === sourceMessageId),
        ),
        'Sender notified',
      )
      continue
    }
    assert.equal(count, depth, 'Full inbox count changed')
    assert.equal(rows.length, depth, 'Full inbox retention changed')
    const ids = new Set(sample.sent.map(({ id }) => id))
    const actual = rows.flatMap(({ sourceMessageId }) =>
      sourceMessageId && ids.has(sourceMessageId) ? [sourceMessageId] : [],
    )
    const expected = sample.sent
      .filter(({ session }) => session.recipients.includes(member))
      .sort((a, b) => time.get(a.id)! - time.get(b.id)!)
      .slice(-depth)
      .map(({ id }) => id)
    assert.deepEqual(
      actual,
      expected,
      'Missing, duplicate, misrouted, or out-of-order retained deliveries',
    )
  }
}

export async function measureWorkload(
  deployment: Deployment,
  members: Member[],
  variant: Variant,
  workload: Workload,
) {
  const mutate = fixtureClient<typeof Fixture>(deployment, 'sharedSendsFixture')
  const { sessions, recipients } = await setup(mutate, members, workload)
  const observers: Observations = new Map(
    recipients.map((recipient) => [
      recipient,
      observeInbox(deployment, recipient, true),
    ]),
  )
  const logs = functionLogs(deployment)
  try {
    await deadline(
      Promise.all([...observers.values()].map(({ ready }) => ready)),
      'recipient and summary subscriptions',
    )
    return await measureRounds(
      logs,
      mutate,
      sessions,
      observers,
      variant,
      workload,
    )
  } finally {
    await Promise.all([...observers.values()].map(({ close }) => close()))
  }
}

async function measureRounds(
  logs: ReturnType<typeof functionLogs>,
  mutate: FixtureClient,
  sessions: Session[],
  observers: Observations,
  variant: Variant,
  workload: Workload,
) {
  const entries: Execution[] = []
  const measured: {
    sample: Sample
    result: Awaited<ReturnType<typeof observe>>
  }[] = []
  const correctnessErrors: string[] = []
  for (
    let ordinal = -warmups;
    ordinal < (workload.rate ? 1 : rounds);
    ordinal++
  ) {
    const rate = ordinal < 0 ? undefined : workload.rate
    await logs.since(250)
    let sample!: Sample
    let result!: Awaited<ReturnType<typeof observe>>
    const run = await collect(logs, async () => {
      sample = await issue(sessions, ordinal, rate)
      result = await observe(sample, observers)
    })
    try {
      await verify(mutate, sample, sessions, observers, workload)
    } catch (error) {
      correctnessErrors.push(
        error instanceof Error ? error.message.split('\n')[0] : String(error),
      )
    }
    correctnessErrors.push(
      ...sample.errors.map((error) => error.split('\n')[0]),
    )
    if (result.missing)
      correctnessErrors.push(
        `Missing ${result.missing} subscriber observations`,
      )
    if (ordinal < 0) continue
    entries.push(...run)
    measured.push({ sample, result })
  }
  const sent = measured.flatMap(({ sample }) => sample.sent)
  const delivery = measured.flatMap(({ result }) =>
    result.receipts.map(({ delay }) => delay),
  )
  const settled = measured.reduce(
    (sum, { result }) => sum + result.settledMs,
    0,
  )
  const work = recipientWork(entries, delivery.length)
  const finalSends = work.mutations.find(
    ({ name }) => name === 'chat:sendMessage',
  )?.completed
  if (sent.length !== finalSends)
    correctnessErrors.push('Incomplete send execution logs')
  if (
    variant !== 'synchronous' &&
    work.queue.drainedEntries !== sent.length * 3
  ) {
    correctnessErrors.push('Incomplete queue delivery logs')
  }
  if (work.queue.pendingAtEnd)
    correctnessErrors.push('Pending notifications at end of workload')
  return {
    variant,
    scenario: workload.name,
    startingUnread: workload.ordinary,
    warmups,
    offeredSendsPerSecond: workload.rate ?? null,
    rejectedSends: measured.reduce(
      (sum, { sample }) => sum + sample.errors.length,
      0,
    ),
    offeredSends: measured.flatMap(({ sample }) => sample.dispatchLag).length,
    achievedSendsPerSecond: workload.rate
      ? sent.length / sustainedSeconds
      : null,
    issueDurationMs: workload.rate ? measured[0].result.issueMs : null,
    dispatchLag: latency(measured.flatMap(({ sample }) => sample.dispatchLag)),
    senderAcknowledgement: latency(
      sent.map(({ acknowledged, dispatched }) => acknowledged - dispatched),
    ),
    recipientVisibility: latency(delivery),
    missingObservations: measured.reduce(
      (sum, { result }) => sum + result.missing,
      0,
    ),
    settledSendsPerSecond: settled ? (sent.length * 1_000) / settled : null,
    drainAfterOfferMs: workload.rate
      ? Math.max(0, settled - sustainedSeconds * 1_000)
      : null,
    ...work,
    correctnessErrors: [...new Set(correctnessErrors)],
  }
}
