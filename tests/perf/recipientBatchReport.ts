import { type Execution, percentiles, queryWork } from './report'

export type Variant = 'synchronous' | 'per-message' | 'per-recipient'

export function latency(samples: number[]) {
  return samples.length
    ? { samples: samples.length, ...percentiles(samples) }
    : { samples: 0 }
}

type QueueEvent = {
  recipientId?: string
  added?: string[]
  removed?: string[]
  oldestAgeMs?: number
}

function queueEvents(log: Execution) {
  const prefix = 'notificationQueue '
  return (log.logLines ?? [])
    .flatMap((line) =>
      typeof line === 'string' ? [line] : (line.messages ?? []),
    )
    .filter((message) => message.includes(prefix))
    .map((message) => {
      // Convex logs string arguments wrapped in single quotes.
      const start = message.indexOf(
        '{',
        message.indexOf(prefix) + prefix.length,
      )
      return JSON.parse(
        message.slice(start, message.lastIndexOf('}') + 1),
      ) as QueueEvent
    })
}

function summarizeQueue(entries: Execution[]) {
  const pending = new Map<string, string>()
  const consumed = new Set<string>()
  const byRecipient = new Map<string, number>()
  const workerSizes: number[] = []
  const ages: number[] = []
  let peak = 0
  let peakPerInbox = 0
  for (const log of entries) {
    if (log.willRetry || log.error) continue
    const events = queueEvents(log)
    let drained = 0
    for (const event of events) {
      for (const id of event.added ?? []) {
        if (consumed.has(id)) continue
        const recipient = event.recipientId!
        pending.set(id, recipient)
        const depth = (byRecipient.get(recipient) ?? 0) + 1
        byRecipient.set(recipient, depth)
        peakPerInbox = Math.max(peakPerInbox, depth)
      }
      for (const id of event.removed ?? []) {
        const recipient = pending.get(id)
        if (recipient)
          byRecipient.set(recipient, byRecipient.get(recipient)! - 1)
        pending.delete(id)
        consumed.add(id)
        drained++
      }
      if (event.oldestAgeMs !== undefined) ages.push(event.oldestAgeMs)
    }
    peak = Math.max(peak, pending.size)
    if (
      log.identifier.endsWith(':_drain') ||
      log.identifier === 'notificationBatch:_deliver'
    ) {
      workerSizes.push(drained)
    }
  }
  return {
    // Completion-log ordering includes scheduling and log publication jitter.
    peakPendingAtCompletions: peak,
    peakPerInboxAtCompletions: peakPerInbox,
    pendingAtEnd: pending.size,
    drainedEntries: consumed.size,
    oldestPendingAgeAtDrainMs: ages.length ? Math.max(...ages) : null,
    oldestAgeAtDrain: latency(ages),
    workerBatchSizes: Object.fromEntries(
      [...new Set(workerSizes)]
        .sort((a, b) => a - b)
        .map((size) => [
          size,
          workerSizes.filter((value) => value === size).length,
        ]),
    ),
  }
}

const metrics = [
  'databaseReadDocuments',
  'databaseReadBytes',
  'databaseWriteDocuments',
  'databaseWriteBytes',
] as const

function mutationWork(entries: Execution[]) {
  const byFunction = new Map<string, Execution[]>()
  for (const entry of entries) {
    if (
      entry.identifier !== 'chat:sendMessage' &&
      !entry.identifier.startsWith('notificationBatch:') &&
      !entry.identifier.startsWith('recipientBatch:')
    )
      continue
    const group = byFunction.get(entry.identifier) ?? []
    group.push(entry)
    byFunction.set(entry.identifier, group)
  }
  return [...byFunction].map(([name, runs]) => {
    const retriesByTable: Record<string, number> = {}
    for (const run of runs) {
      if (!run.willRetry) continue
      const table = run.occInfo?.tableName ?? 'unknown'
      retriesByTable[table] = (retriesByTable[table] ?? 0) + 1
    }
    const total = Object.fromEntries(
      metrics.map((metric) => {
        const values = runs.map((run) => run.usageStats[metric])
        if (!values.every(Number.isFinite))
          throw new Error(`Missing Convex metric ${metric}`)
        return [metric, values.reduce((sum, value) => sum + value, 0)]
      }),
    )
    return {
      name,
      attempts: runs.length,
      completed: runs.filter((r) => !r.willRetry && !r.error).length,
      failures: runs.filter((r) => !r.willRetry && r.error).length,
      retriesByTable,
      total,
    }
  })
}

export function recipientWork(entries: Execution[], deliveries: number) {
  const mutations = mutationWork(entries)
  const subscriptions = {
    unread: queryWork(entries, 'notifications:list'),
    summary: queryWork(entries, 'notifications:summary'),
  }
  const perDelivery = (value: number) =>
    deliveries ? value / deliveries : null
  const mutationPerDelivery = Object.fromEntries(
    metrics.map((metric) => [
      metric,
      perDelivery(
        mutations.reduce((total, { total: work }) => total + work[metric], 0),
      ),
    ]),
  )
  const totalDatabaseBytesPerDelivery = perDelivery(
    mutations.reduce(
      (sum, { total }) =>
        sum + total.databaseReadBytes + total.databaseWriteBytes,
      0,
    ) +
      subscriptions.unread.bytes +
      subscriptions.summary.bytes,
  )
  return {
    queue: summarizeQueue(entries),
    mutations,
    subscriptions,
    mutationPerDelivery,
    totalDatabaseBytesPerDelivery,
  }
}
