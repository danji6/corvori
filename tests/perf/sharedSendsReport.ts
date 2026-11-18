import { strict as assert } from 'node:assert'

import { type Execution, percentiles, queryWork, timings } from './report'

const SEND = 'chat:sendMessage'
const WORKER = 'notificationBatch:_deliver'
const metrics = [
  'databaseReadDocuments',
  'databaseReadBytes',
  'databaseWriteDocuments',
  'databaseWriteBytes',
] as const

export function work(entries: Execution[], samples: number, name = SEND) {
  const runs = entries.filter(
    (entry) => entry.identifier === name && !entry.willRetry,
  )
  assert.equal(runs.length, samples, `Missing or extra ${name} execution logs`)
  assert.ok(
    runs.every((run) => !run.error),
    `${name} failed`,
  )
  return {
    databaseReadDocuments: metricWork(runs, 'databaseReadDocuments'),
    databaseReadBytes: metricWork(runs, 'databaseReadBytes'),
    databaseWriteDocuments: metricWork(runs, 'databaseWriteDocuments'),
    databaseWriteBytes: metricWork(runs, 'databaseWriteBytes'),
  }
}

function metricWork(runs: Execution[], metric: (typeof metrics)[number]) {
  const values = runs.map((run) => run.usageStats[metric])
  assert.ok(values.every(Number.isFinite), `Missing Convex metric ${metric}`)
  return {
    mean: values.reduce((total, value) => total + value, 0) / runs.length,
    max: Math.max(...values),
  }
}

function conflictCounts(entries: Execution[], name = SEND) {
  const byTable = new Map<string, number>()
  for (const entry of entries) {
    if (entry.identifier !== name || !entry.willRetry) continue
    const table = entry.occInfo?.tableName ?? 'unknown'
    byTable.set(table, (byTable.get(table) ?? 0) + 1)
  }
  return {
    retries: [...byTable.values()].reduce((total, count) => total + count, 0),
    retriesByTable: Object.fromEntries(byTable),
  }
}

type Notifications = 'synchronous' | 'scheduled'
type TimingSamples = {
  acknowledgements: number[]
  deliveryTimes: number[]
  deliveryAfterAck: number[]
  sendElapsed: number
  settledElapsed: number
}

export function summarizeRounds(
  entries: Execution[],
  samples: TimingSamples,
  warmups: number,
  notifications?: Notifications,
) {
  const { acknowledgements, deliveryTimes, sendElapsed } = samples
  return {
    acknowledgement: timings(acknowledgements, sendElapsed, warmups),
    work: work(entries, acknowledgements.length),
    recipientDelivery: deliveryTimes.length
      ? { samples: deliveryTimes.length, ...percentiles(deliveryTimes) }
      : { samples: 0 },
    ...conflictCounts(entries),
    ...(notifications && summarizeDelivery(entries, samples, notifications)),
  }
}

function summarizeDelivery(
  entries: Execution[],
  { acknowledgements, deliveryAfterAck, settledElapsed }: TimingSamples,
  notifications: Notifications,
) {
  const samples = acknowledgements.length
  const writes = new Set(
    notifications === 'scheduled' ? [SEND, WORKER] : [SEND],
  )
  const attemptedWrites = entries.filter((entry) =>
    writes.has(entry.identifier),
  )
  const databaseWorkPerSend = Object.fromEntries(
    metrics.map((metric) => [
      metric,
      (metricWork(attemptedWrites, metric).mean * attemptedWrites.length) /
        samples,
    ]),
  )
  return {
    notifications,
    deliveryAfterAcknowledgement: {
      samples: deliveryAfterAck.length,
      ...percentiles(deliveryAfterAck),
    },
    settledSendsPerSecond: +((1_000 * samples) / settledElapsed).toFixed(1),
    messageAndDeliveryDatabaseWorkPerSend: databaseWorkPerSend,
    inboxSubscriptionWork: queryWork(entries, 'notifications:list'),
    ...(notifications === 'scheduled' && {
      deliveryWorker: {
        samples,
        work: work(entries, samples, WORKER),
        ...conflictCounts(entries, WORKER),
      },
    }),
  }
}
