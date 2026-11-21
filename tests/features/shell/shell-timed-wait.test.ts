import { positionFromRanges } from '@cv/convex/model/shell/outputDeliveries'
import {
  executeShellJob,
  executeShellOutput,
} from '@cv/convex/model/tool/shell'
import {
  shellWaitSeconds,
  waitForShell,
} from '@cv/convex/model/tool/shellTimedWait'
import { SHELL_PAGE_CHARS } from '@cv/core/shell/output-page'
import { describe, expect, test } from 'bun:test'
import { collect, context } from '~/tests/helpers/shell-job'
import { pageSidecar } from '~/tests/helpers/shell-page'

describe('timed shell waits', () => {
  test('defaults to 60 seconds', () => {
    expect(shellWaitSeconds()).toBe(60)
  })

  test('returns early when the job exits', async () => {
    const sidecar = pageSidecar('started\n', 'running')
    sidecar.frames.push({ text: 'finished\n', status: 'done', exitCode: 7 })
    const outputs = await collect(
      waitForShell(context, 'job-1', Date.now() + 60_000, sidecar, false),
    )

    expect(outputs.at(-1)).toMatchObject({
      status: 'done',
      exitCode: 7,
      text: 'started\nfinished\n',
    })
    expect(
      outputs.filter((output) => output.status !== 'running'),
    ).toHaveLength(1)
  })

  test('waits through a full page and leaves the skipped prefix unread', async () => {
    const prefix = 'older\n'
    const recent = 'x'.repeat(SHELL_PAGE_CHARS - 1) + '\n'
    const sidecar = pageSidecar(prefix + recent, 'running')
    const deadline = Date.now() + 25
    const outputs = await collect(
      waitForShell(context, 'job-1', deadline, sidecar, false),
    )
    const result = outputs.at(-1)!

    expect(Date.now()).toBeGreaterThanOrEqual(deadline)
    expect(result.text).toBe(recent)
    expect(result.range).toMatchObject({
      skipped: { start: 0, end: prefix.length },
      hasMore: true,
    })
    const readPosition = positionFromRanges([result.range!])
    expect(readPosition.offset).toBe(0)
    const reads = await collect(
      executeShellOutput(
        context,
        { jobId: 'job-1', wait_seconds: 0 },
        { ...sidecar, readPosition },
      ),
    )
    expect(reads.at(-1)?.text).toBe(prefix)
    expect(reads.at(-1)?.range?.hasMore).toBe(false)
  })

  test('carries the original deadline over an execution window with a silent job', async () => {
    const sidecar = pageSidecar('', 'running')
    const waitUntil = Date.now() + 60_000
    const outputs = await collect(
      waitForShell(
        context,
        'job-1',
        waitUntil,
        {
          ...sidecar,
          windowDeadline: Date.now() + 10,
        },
        true,
      ),
    )

    expect(outputs.at(-1)).toMatchObject({ status: 'running', waitUntil })
    expect(sidecar.closed()).toBe(1)
    sidecar.frames.push({ text: 'done\n', status: 'done' })
    const resumed = await collect(
      waitForShell(context, 'job-1', waitUntil, sidecar, true),
    )
    expect(resumed.at(-1)).toMatchObject({ status: 'done', text: 'done\n' })
  })

  test('returns a handle at expiry and leaves a launched job in the background', async () => {
    const sidecar = pageSidecar('', 'running')
    const requests: string[] = []
    const outputs = await collect(
      executeShellJob(
        context,
        { command: 'sleep 30', wait_seconds: 0.02 },
        {
          ...sidecar,
          onStarted: async () => 3,
          post: async (path, body) => {
            requests.push(path)
            if (path === '/shell/start')
              return { jobId: 'job-1', mode: 'pipe' } as never
            if (path === '/shell/background') return {} as never
            return sidecar.post(path, body)
          },
        },
      ),
    )

    expect(outputs.at(-1)).toMatchObject({ status: 'background', jobNumber: 3 })
    expect(requests).toEqual([
      '/shell/start',
      '/shell/background',
      '/shell/poll',
    ])
  })

  test('cancels a read wait without killing the job', async () => {
    const sidecar = pageSidecar('', 'running')
    const controller = new AbortController()
    const wait = waitForShell(
      context,
      'job-1',
      Date.now() + 60_000,
      {
        ...sidecar,
        abortSignal: controller.signal,
      },
      false,
    )
    await wait.next()
    controller.abort()
    expect((await wait.next()).done).toBe(true)
    expect(await sidecar.post('/shell/poll', { offset: 0 })).toMatchObject({
      status: 'running',
    })
  })
})
