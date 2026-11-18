import type { Browser, Page } from '@playwright/test'
import { strict as assert } from 'node:assert'
import { setInterval } from 'node:timers/promises'

type ProcessRow = { pid: number; ppid: number; rssBytes: number }

async function processMemory(): Promise<ProcessRow[]> {
  const child = Bun.spawn(['ps', '-e', '-o', 'pid=,ppid=,rss='], {
    stdout: 'pipe',
    stderr: 'inherit',
  })
  const [output, code] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ])
  assert.equal(code, 0, 'Could not sample process RSS')
  return output
    .trim()
    .split('\n')
    .map((line) => {
      const [pid, ppid, kibibytes] = line.trim().split(/\s+/).map(Number)
      return { pid, ppid, rssBytes: kibibytes * 1024 }
    })
}

function treeRss(rows: ProcessRow[], pid: number) {
  const root = rows.find((row) => row.pid === pid)
  assert.ok(root, `Process ${pid} exited while measuring memory`)
  let bytes = root.rssBytes
  const parents = [pid]
  for (const parent of parents) {
    for (const row of rows) {
      if (row.ppid !== parent) continue
      bytes += row.rssBytes
      parents.push(row.pid)
    }
  }
  return bytes
}

export async function memoryProbe(
  browser: Browser,
  page: Page,
  convexPid: number,
  sidecarPid: number,
) {
  const system = await browser.newBrowserCDPSession()
  const { processInfo } = await system.send('SystemInfo.getProcessInfo')
  const chromiumPid = processInfo.find(({ type }) => type === 'browser')?.id
  assert.ok(chromiumPid, 'Chromium did not report its browser process ID')
  await system.detach()

  const tab = await page.context().newCDPSession(page)
  return {
    async sample(collectPageGarbage = false) {
      if (collectPageGarbage) await tab.send('HeapProfiler.collectGarbage')
      const [rows, heap, dom] = await Promise.all([
        processMemory(),
        tab.send('Runtime.getHeapUsage'),
        tab.send('Memory.getDOMCounters'),
      ])
      return {
        convexRssBytes: treeRss(rows, convexPid),
        sidecarRssBytes: treeRss(rows, sidecarPid),
        chromiumRssBytes: treeRss(rows, chromiumPid),
        tabUsedHeapBytes: heap.usedSize,
        tabDocuments: dom.documents,
        tabNodes: dom.nodes,
        tabEventListeners: dom.jsEventListeners,
      }
    },
  }
}

type Probe = Awaited<ReturnType<typeof memoryProbe>>
export type MemorySnapshot = Awaited<ReturnType<Probe['sample']>>
export const memorySampleIntervalMs = 250

export async function sampleWhile<T>(probe: Probe, run: () => Promise<T>) {
  const peak = await probe.sample()
  const keys = Object.keys(peak) as (keyof MemorySnapshot)[]
  const stop = new AbortController()
  let samples = 1
  const include = (point: MemorySnapshot) => {
    for (const key of keys) peak[key] = Math.max(peak[key], point[key])
    samples++
  }
  const read = async () => {
    for await (const _ of setInterval(memorySampleIntervalMs, null, {
      signal: stop.signal,
      ref: false,
    })) {
      include(await probe.sample())
    }
  }
  let failure: unknown
  const sampling = read().catch((error: unknown) => {
    if (!(error instanceof Error && error.name === 'AbortError'))
      failure = error
  })
  let result: T
  try {
    result = await run()
  } finally {
    stop.abort()
    await sampling
  }
  if (failure) throw failure
  include(await probe.sample())
  return { result, samples, peak }
}
