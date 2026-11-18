import { mkdir } from 'node:fs/promises'
import { arch, availableParallelism, platform, release } from 'node:os'
import { join } from 'node:path'
import { projectRoot } from '~/scripts/runner/config'

import type { Deployment } from './deployment'

export function createReport(
  suite: string,
  metadata: Record<string, unknown> = {},
) {
  const report = {
    commit: Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: projectRoot })
      .stdout.toString()
      .trim(),
    dirty:
      Bun.spawnSync(['git', 'status', '--porcelain'], { cwd: projectRoot })
        .stdout.length > 0,
    bun: Bun.version,
    ...metadata,
    runner: {
      platform: platform(),
      arch: arch(),
      release: release(),
      cpus: availableParallelism(),
    },
    runs: [] as Record<string, unknown>[],
    errors: [] as string[],
  }

  function record(run: Record<string, unknown>) {
    report.runs.push(run)
    console.log(JSON.stringify(run))
  }

  async function writeReport(error?: unknown) {
    if (error)
      report.errors.push(error instanceof Error ? error.message : String(error))
    const directory = join(projectRoot, 'test-results', 'perf')
    await mkdir(directory, { recursive: true })
    const path = join(directory, `${suite}.json`)
    await Bun.write(path, JSON.stringify(report, null, 2) + '\n')
    console.log(`Report written to ${path}`)
  }

  return { record, writeReport }
}

export function percentiles(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b)
  const percentile = (p: number) =>
    +sorted[Math.ceil(p * sorted.length) - 1].toFixed(1)
  return { p50Ms: percentile(0.5), p95Ms: percentile(0.95) }
}

export function timings(samples: number[], elapsedMs: number, warmups: number) {
  return {
    samples: samples.length,
    warmups,
    updatesPerSecond: +((1000 * samples.length) / elapsedMs).toFixed(1),
    ...percentiles(samples),
  }
}

export type Execution = {
  kind: 'Completion'
  identifier: string
  cachedResult: boolean
  executionId: string
  parentExecutionId?: string | null
  error?: string | null
  executionTimestamp: number
  logLines?: Array<{ messages?: string[] } | string>
  willRetry: boolean
  occInfo?: { tableName?: string | null } | null
  usageStats: {
    databaseReadDocuments: number
    databaseReadBytes: number
    databaseWriteDocuments: number
    databaseWriteBytes: number
  }
}
type FunctionExecution = Execution | { kind: 'Progress' }

export function functionLogs(deployment: Deployment) {
  let cursor = 0
  const since = async (timeoutMs = 1_500) => {
    const url = `${deployment.url}/api/stream_function_logs?cursor=${cursor}`
    const signal = AbortSignal.timeout(timeoutMs)
    const response = await fetch(url, {
      headers: { Authorization: `Convex ${deployment.key}` },
      signal,
    }).catch((error: unknown) => {
      // The endpoint long-polls when the cursor has caught up.
      if (signal.aborted) return null
      throw error
    })
    if (!response) return []
    if (!response.ok)
      throw new Error(`Convex function logs failed (${response.status})`)
    const { entries, newCursor } = (await response.json()) as {
      entries: FunctionExecution[]
      newCursor: number
    }
    cursor = newCursor
    return entries.filter(
      (entry): entry is Execution => entry.kind === 'Completion',
    )
  }
  return { since }
}

export function queryWork(entries: Execution[], identifier: string) {
  const runs = entries.filter(
    (entry) => entry.identifier === identifier && !entry.cachedResult,
  )
  return {
    executions: runs.length,
    documents: runs.reduce(
      (total, run) => total + run.usageStats.databaseReadDocuments,
      0,
    ),
    bytes: runs.reduce(
      (total, run) => total + run.usageStats.databaseReadBytes,
      0,
    ),
    maxDocuments: Math.max(
      0,
      ...runs.map((run) => run.usageStats.databaseReadDocuments),
    ),
  }
}
