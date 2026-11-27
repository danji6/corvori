/// <reference types="bun-types" />
import { safeValidateTypes } from '@ai-sdk/provider-utils'
import type * as ShellToolModule from '@cv/convex/model/tool/shell'
import type { ShellToolOutput } from '@cv/core/types/tools'
import type * as RegistryModule from '@cv/sidecar/shell/registry'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import { waitForExit } from '~/tests/helpers/shell-registry'
import { createTempDirectory } from '~/tests/helpers/temp-directory'

const previousEnvironment = {
  CHAT_SIDECAR_DATA_DIR: process.env.CHAT_SIDECAR_DATA_DIR,
  SIDECAR_URL: process.env.SIDECAR_URL,
}
let dataDirectory: string | undefined

let registry: typeof RegistryModule
let shellTool: typeof ShellToolModule
let server: ReturnType<typeof Bun.serve>

const context = { sessionId: 'session-1', workspaceId: 'ws-1' }

beforeAll(async () => {
  dataDirectory = await createTempDirectory('shell-stream-')
  process.env.CHAT_SIDECAR_DATA_DIR = dataDirectory
  registry = await import('@cv/sidecar/shell/registry')
  shellTool = await import('@cv/convex/model/tool/shell')

  const { createApp } = await import('@cv/sidecar/main')
  const app = createApp(async (_c, next) => next())
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: app.fetch })
  process.env.SIDECAR_URL = server.url.origin
})

afterAll(async () => {
  server?.stop(true)
  for (const [name, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  if (dataDirectory) await rm(dataDirectory, { recursive: true, force: true })
})

/** Starts the job here, so the tool only has to watch it over real HTTP. */
async function startedJob(command: string, allowInteractiveShells = false) {
  const job = await registry.startShellJob({
    ...context,
    command,
    allowInteractiveShells,
    cwd: process.cwd(),
  })
  return { jobId: job.jobId, post: async () => job }
}

/** Collects parts until `done` says stop, or the deadline passes. */
async function collect(
  parts: AsyncIterable<ShellToolOutput>,
  done: (part: ShellToolOutput) => boolean,
  timeoutMs = 8_000,
) {
  const seen: ShellToolOutput[] = []
  const deadline = Date.now() + timeoutMs
  for await (const part of parts) {
    seen.push(part)
    if (done(part) || Date.now() > deadline) break
  }
  return seen
}

describe('shell job streaming over http', () => {
  /**
   * The whole point of the SSE push: a job that has not exited yet must still
   * surface its output. When only completed jobs report back, a command that
   * blocks (a pager waiting for a keypress) leaves the tool call with no
   * output at all — nothing to render, expand, or flag as waiting.
   */
  test('yields output while the job is still running', async () => {
    const { jobId, post } = await startedJob('echo streaming-live; sleep 30')

    const started = Date.now()
    const parts = shellTool.executeShellJob(context, { command: 'ignored' }, {
      post,
    } as Parameters<typeof shellTool.executeShellJob>[2])

    const seen = await collect(parts, (part) =>
      part.term.includes('streaming-live'),
    )
    const elapsed = Date.now() - started

    const live = seen.at(-1)
    expect(live?.status).toBe('running')
    expect(live?.term).toContain('streaming-live')
    // Well before the command itself could have finished
    expect(elapsed).toBeLessThan(10_000)

    registry.killShellJob(jobId, context.sessionId)
  })

  test('yields a final part once the job exits', async () => {
    const { post } = await startedJob('echo all-done')

    const seen = await collect(
      shellTool.executeShellJob(context, { command: 'ignored' }, {
        post,
      } as Parameters<typeof shellTool.executeShellJob>[2]),
      (part) => part.status !== 'running',
    )

    const final = seen.at(-1)
    expect(final?.status).toBe('done')
    expect(final?.exitCode).toBe(0)
    expect(final?.text).toContain('all-done')
  })

  test('reads and kills an unfinished job by its chat number', async () => {
    const path = await createTempDirectory('shell-wait-')
    const workspace = {
      workspaceId: context.workspaceId,
      path,
      label: 'Test workspace',
      sources: [{ id: 'test', path, label: 'Test workspace' }],
    }
    let jobId: string | undefined
    try {
      const outputs = await collect(
        shellTool.executeShellJob(
          { ...context, workspace },
          { command: 'sleep 30', wait_seconds: 0.1 },
          {
            onStarted: async (id) => {
              jobId = id
              return 3
            },
          },
        ),
        (part) => part.status !== 'running',
      )
      expect(outputs.at(-1)).toMatchObject({
        jobNumber: 3,
        status: 'background',
      })
      expect(registry.pollShellJob(jobId!, context.sessionId, 0)).toMatchObject(
        {
          status: 'running',
          background: true,
        },
      )
      const { createShellOutputTool, createKillShellTool } =
        await import('@cv/convex/model/tool/shellTools')
      const toolContext = {
        ...context,
        sessionId: context.sessionId as never,
        ownerId: context.sessionId as never,
        workspace,
        findShell: async (handle: string) =>
          handle === '3'
            ? {
                jobId: jobId!,
                number: 3,
                command: 'sleep 30',
                toolCallId: 'start',
              }
            : null,
      }
      const read = await createShellOutputTool(toolContext)
      const kill = await createKillShellTool(toolContext)
      for (const { inputSchema } of [read, kill]) {
        const result = await safeValidateTypes({
          value: { jobId },
          schema: inputSchema as never,
        })
        expect(result.success).toBe(false)
      }

      const options = {
        toolCallId: 'next',
        messages: [],
        context: undefined as never,
      }
      const readResult = read.execute!({ jobId: '3', wait_seconds: 0 }, options)
      if (!(Symbol.asyncIterator in readResult))
        throw new Error('Expected a streaming read')
      const reads = await collect(readResult, () => false)
      expect(reads.at(-1)).toMatchObject({ jobNumber: 3, status: 'background' })
      expect(await kill.execute!({ jobId: '3' }, options)).toBe('Killed job 3')
      expect((await waitForExit(jobId!)).status).toBe('killed')
    } finally {
      if (jobId) {
        registry.killShellJob(jobId, context.sessionId)
        await waitForExit(jobId)
      }
      await rm(path, { recursive: true, force: true })
    }
  })

  test.skipIf(process.platform !== 'linux')(
    'reports a job waiting on terminal input',
    async () => {
      const { jobId, post } = await startedJob(
        'read -r line; echo "got:$line"',
        true,
      )

      const seen = await collect(
        shellTool.executeShellJob(context, { command: 'ignored' }, {
          post,
        } as Parameters<typeof shellTool.executeShellJob>[2]),
        (part) => part.waiting === true,
      )

      expect(seen.at(-1)?.waiting).toBe(true)

      registry.killShellJob(jobId, context.sessionId)
    },
  )

  test.skipIf(process.platform !== 'linux')(
    'returns a non-interactive retry error to the agent without requesting input',
    async () => {
      const { post } = await startedJob('read -r line; echo "got:$line"')
      const seen = await collect(
        shellTool.executeShellJob(context, { command: 'ignored' }, {
          post,
        } as Parameters<typeof shellTool.executeShellJob>[2]),
        (part) => part.status !== 'running',
      )

      expect(seen.some((part) => part.waiting)).toBe(false)
      const final = seen.at(-1)!
      expect(final.status).toBe('killed')
      expect(shellTool.shellToModelOutput({ output: final })).toMatchObject({
        type: 'text',
        value: expect.stringContaining('Try a non-interactive command instead'),
      })
    },
  )
})

describe('watching a job that outlived its tool call', () => {
  /**
   * A tool watcher stops as soon as the job goes to the background. The
   * reporting watcher exists for exactly that job, so it must keep going and
   * only end when the job actually exits.
   */
  test('keeps watching a backgrounded job until it exits', async () => {
    const { jobId } = await startedJob('sleep 0.4; echo late-output')
    registry.backgroundShellJob(jobId, context.sessionId)

    const seen = await collect(
      shellTool.watchBackgroundJob(context, {
        jobId,
        term: '',
        termOffset: 0,
      }),
      (part) => part.status !== 'running',
    )

    const final = seen.at(-1)
    expect(final?.status).toBe('done')
    expect(final?.exitCode).toBe(0)
    expect(final?.text).toContain('late-output')
  })

  test('hands a still-running job to the next window', async () => {
    const { jobId } = await startedJob('sleep 30')

    const seen = await collect(
      shellTool.watchBackgroundJob(
        context,
        { jobId, term: '', termOffset: 0 },
        { windowDeadline: Date.now() + 500 },
      ),
      () => false,
    )

    // The generator ends on its own, with the job left running
    expect(seen.at(-1)?.status).toBe('running')

    registry.killShellJob(jobId, context.sessionId)
  })
})
