import { strict as assert } from 'node:assert'

import { type Script, now } from './activeStreamingProvider'
import { type Execution, type functionLogs, percentiles } from './report'

const ENGINE = 'actions/streams:_stream'
const PATCH = 'streams:_patchMessage'
const POLL = 'streams:_isActive'

export function latency(values: number[]) {
  if (!values.length) return { samples: 0, p50Ms: null, p95Ms: null }
  assert.ok(values.every((value) => Number.isFinite(value) && value >= 0))
  return { samples: values.length, ...percentiles(values) }
}

export async function completedBatch(
  logs: ReturnType<typeof functionLogs>,
  turns: number,
) {
  const entries: Execution[] = []
  const until = now() + 15_000
  while (now() < until) {
    const page = await logs.since()
    entries.push(...page)
    const engines = entries.filter(({ identifier }) => identifier === ENGINE)
    if (!page.length && engines.length >= turns) {
      assert.equal(engines.length, turns, 'Unexpected stream engine executions')
      assert.ok(
        engines.every(({ error }) => !error),
        'Stream engine execution failed',
      )
      return entries
    }
  }
  throw new Error('Missing stream action completion logs')
}

export function overlap(intervals: { start: number; end: number }[]) {
  const events = intervals.flatMap(({ start, end }) => [
    { at: start, delta: 1 },
    { at: end, delta: -1 },
  ])
  events.sort((left, right) => left.at - right.at || left.delta - right.delta)
  let running = 0
  let peak = 0
  for (const { delta } of events) {
    running += delta
    peak = Math.max(peak, running)
  }
  return peak
}

export async function intervalsFor(scripts: Script[]) {
  return Promise.all(
    scripts.map(async (script) => ({
      start: script.requestedAt,
      end: (await script.ended()).at,
    })),
  )
}

function totals(entries: Execution[]) {
  const stats = {
    calls: entries.length,
    cacheHits: 0,
    retries: 0,
    databaseReadDocuments: 0,
    databaseReadBytes: 0,
    databaseWriteDocuments: 0,
    databaseWriteBytes: 0,
  }
  for (const { usageStats, cachedResult, willRetry } of entries) {
    stats.cacheHits += Number(cachedResult)
    stats.retries += Number(willRetry)
    if (cachedResult) continue
    for (const metric of [
      'databaseReadDocuments',
      'databaseReadBytes',
      'databaseWriteDocuments',
      'databaseWriteBytes',
    ] as const) {
      assert.ok(
        Number.isFinite(usageStats[metric]),
        `Missing Convex metric ${metric}`,
      )
      stats[metric] += usageStats[metric]
    }
  }
  return stats
}

const terminalFunctions = new Set([
  'chat:stopStream',
  'streams:_finalizeStopped',
  'streams:_complete',
  'streams:_saveMeta',
  'streams:_recordStep',
  'streams:_fail',
])

export function streamWork(entries: Execution[], seconds: number) {
  const patches = entries.filter(({ identifier }) => identifier === PATCH)
  // Each normally completed one-step turn finishes with one final patch.
  const finished = new Set(
    entries.flatMap((entry) =>
      entry.identifier === 'streams:_complete' && entry.parentExecutionId
        ? [entry.parentExecutionId]
        : [],
    ),
  )
  const final = new Map<string, Execution>()
  for (const entry of patches) {
    if (
      entry.willRetry ||
      !entry.parentExecutionId ||
      !finished.has(entry.parentExecutionId)
    )
      continue
    const prior = final.get(entry.parentExecutionId)
    if (!prior || prior.executionTimestamp <= entry.executionTimestamp)
      final.set(entry.parentExecutionId, entry)
  }
  assert.equal(
    final.size,
    entries.filter(
      (entry) => entry.identifier === 'streams:_complete' && !entry.willRetry,
    ).length,
    'Missing terminal patch correlation',
  )
  const terminalIds = new Set(
    [...final.values()].map(({ executionId }) => executionId),
  )
  const partial = patches.filter(
    ({ executionId, usageStats, willRetry }) =>
      !terminalIds.has(executionId) &&
      !willRetry &&
      usageStats.databaseWriteDocuments > 0,
  )
  const work = new Map<string, Execution[]>()
  for (const entry of entries) {
    if (
      entry.identifier === ENGINE ||
      entry.identifier === 'activeStreamingFixture:stopText'
    )
      continue
    const key = terminalIds.has(entry.executionId)
      ? `${PATCH}:final`
      : entry.identifier
    const list = work.get(key) ?? []
    list.push(entry)
    work.set(key, list)
  }
  const terminal = entries.filter(
    (entry) =>
      terminalIds.has(entry.executionId) ||
      terminalFunctions.has(entry.identifier),
  )
  const all = totals([...work.values()].flat())
  const periodic = totals([
    ...entries.filter(({ identifier }) => identifier === POLL),
    ...partial,
  ])
  return {
    activeStreamSeconds: +seconds.toFixed(3),
    all,
    allPerStreamSecond: perSecond(all, seconds),
    partialPatches: totals(partial),
    terminal: totals(terminal),
    periodicPerStreamSecond: perSecond(periodic, seconds),
    functions: Object.fromEntries(
      [...work.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, calls]) => {
          const stats = totals(calls)
          return [
            name,
            { ...stats, perStreamSecond: perSecond(stats, seconds) },
          ]
        }),
    ),
  }
}

function perSecond(stats: ReturnType<typeof totals>, seconds: number) {
  return Object.fromEntries(
    Object.entries(stats).map(([name, value]) => [
      name,
      +(value / seconds).toFixed(2),
    ]),
  )
}
