import { approvalHold } from '@cv/convex/lib/tool/approvalPolicy'
import type { WorkspaceToolContext } from '@cv/convex/model/tool/context'
import type { ShellJobInput } from '@cv/convex/model/tool/shell'
import { shellApprovalPolicy } from '@cv/convex/model/tool/shellApproval'
import {
  createShellOutputTool,
  createShellTool,
} from '@cv/convex/model/tool/shellTools'
import {
  approvalRememberOption,
  approvalSummary,
} from '@cv/core/approval-presentation'
import type { ShellRetryAccess } from '@cv/core/shell/retry'
import type { ShellToolOutput } from '@cv/core/types/tools'
import { type ToolSet, streamText } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nativeShellSidecar } from '~/tests/helpers/native-shell-sidecar'

describe.skipIf(
  process.platform === 'win32' || process.env.CORVORI_NATIVE_TEST !== '1',
)('native shell retry approval', () => {
  let root: string
  let sandbox: string
  let server: ReturnType<typeof Bun.serve>
  let originalUrl: string | undefined
  let sidecar: Awaited<ReturnType<typeof nativeShellSidecar>>
  let shell: Awaited<ReturnType<typeof createShellTool>>
  let context: WorkspaceToolContext
  const jobs = new Map<
    string,
    { jobId: string; number: number; command: string; toolCallId: string }
  >()
  let number = 0

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'corvori-retry-')))
    sandbox = join(root, 'workspace')
    await mkdir(sandbox)
    await writeFile(join(sandbox, '.gitignore'), '*.private\n')
    await writeFile(join(sandbox, 'protected.private'), 'fixture')
    await writeFile(join(root, 'outside'), 'fixture')
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Response('ok'),
    })
    originalUrl = process.env.SIDECAR_URL
    sidecar = await nativeShellSidecar(join(root, 'sidecar'), 'pipe')
    process.env.SIDECAR_URL = sidecar.url
    context = {
      sessionId: 'retry-session',
      ownerId: 'retry-owner',
      workspaceId: 'workspace',
      workspace: {
        workspaceId: 'workspace',
        revision: 1,
        path: sandbox,
        label: 'workspace',
        sources: [{ id: 'source', path: sandbox, label: 'workspace' }],
      },
      findShell: async (id) => jobs.get(id) ?? null,
      bindShell: async (jobId, toolCallId, command) => {
        const n = ++number
        jobs.set(String(n), { jobId, toolCallId, command, number: n })
        return n
      },
    } as WorkspaceToolContext
    shell = await createShellTool(context)
  })
  afterAll(async () => {
    server?.stop(true)
    await sidecar?.close()
    if (originalUrl === undefined) delete process.env.SIDECAR_URL
    else process.env.SIDECAR_URL = originalUrl
    if (root) await rm(root, { recursive: true, force: true })
  })

  async function execute(input: ShellJobInput, toolCallId: string) {
    const output = shell.execute!(input, {
      toolCallId,
      messages: [],
      context: undefined as never,
    }) as AsyncIterable<ShellToolOutput>
    return (await Array.fromAsync(output)).at(-1)!
  }

  async function approveRequest(input: ShellJobInput, toolCallId: string) {
    const config = shellApprovalPolicy({ shell } as unknown as ToolSet)
    const gate = typeof config === 'object' && config.shell
    if (typeof gate !== 'function')
      throw new Error('Expected shell approval policy')
    return gate(input, {
      toolCallId,
      messages: [],
      toolContext: undefined as never,
      runtimeContext: undefined,
    })
  }

  test.each(['filesystem', 'network', 'both'] as const)(
    'restarts once with only %s access',
    async (access) => {
      const count = join(sandbox, access + '-starts')
      const url = 'http://127.0.0.1:' + server.port + '/fixture'
      const script = [
        'printf x >> ' + access + '-starts',
        'file=no; network=no',
        'if [ "$(/bin/cat protected.private 2>/dev/null)" = fixture ]; then file=yes; fi',
        'if /usr/bin/curl -qsfS --max-time 2 ' +
          url +
          ' >/dev/null; then network=yes; fi',
        'echo "$file $network"',
        'test "$file $network" != "no no" || exit 42',
      ].join('\n')
      const first = await execute({ command: script }, access + '-first')
      expect(first.text).toContain('no no')
      expect(first.exitCode).toBe(42)
      const request = {
        command: script,
        cwd: sandbox,
        description: 'Read the fixture or reach the test endpoint',
        retry: { jobId: String(first.jobNumber), access },
      }
      const call = access + '-retry'
      expect(await approveRequest(request, call)).toBe('user-approval')
      expect(await readFile(count, 'utf8')).toBe('x')
      expect(
        approvalRememberOption(
          approvalHold('shell', request, undefined),
          'Remember',
        ),
      ).toBeUndefined()
      expect(approvalSummary('shell', request)).toContain('Agent’s reason')
      const runs = await Promise.allSettled([
        execute(request, call),
        execute(request, call),
      ])
      const done = runs.filter((r) => r.status === 'fulfilled')
      expect(done).toHaveLength(1)
      const result = done[0]!.value
      const expected: Record<ShellRetryAccess, string> = {
        filesystem: 'yes no',
        network: 'no yes',
        both: 'yes yes',
      }
      expect(result.text).toContain(expected[access])
      expect(result.exitCode).toBe(0)
      expect(await readFile(count, 'utf8')).toBe('xx')
      expect(jobs.get(request.retry.jobId)?.jobId).toBe(first.jobId)
    },
  )

  test('a background terminal keeps its failure and retry directory', async () => {
    const terminal = await nativeShellSidecar(
      join(root, 'terminal-sidecar'),
      'pty',
    )
    process.env.SIDECAR_URL = terminal.url
    try {
      const command = 'test -t 1 || exit 41; printf before; exit 42'
      const first = await execute(
        { command, wait_seconds: 0 },
        'terminal-first',
      )
      expect(first.status).toBe('background')
      const reader = await createShellOutputTool(context)
      const pages = reader.execute!(
        { jobId: String(first.jobNumber), wait_seconds: 5 },
        {
          toolCallId: 'terminal-read',
          messages: [],
          context: undefined as never,
        },
      ) as AsyncIterable<ShellToolOutput>
      const failed = (await Array.fromAsync(pages)).at(-1)!
      expect(failed.text.trim()).toBe('before')
      expect(failed.exitCode).toBe(42)
      expect(failed.retryCwd).toBe(sandbox)
    } finally {
      process.env.SIDECAR_URL = sidecar.url
      await terminal.close()
    }
  })

  test('approval history resumes a silent failure exactly once', async () => {
    const command =
      'printf x >> history-starts; /bin/cat ../outside >/dev/null 2>&1 || exit 42'
    const first = await execute({ command }, 'first-history')
    expect(first.text.trim()).toBe('')
    const request = {
      command,
      cwd: first.retryCwd,
      description: 'Read the disposable sibling file',
      retry: { jobId: String(first.jobNumber), access: 'filesystem' },
    }
    const tools = { shell } as unknown as ToolSet
    let emitRequest = true
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] })
            if (emitRequest)
              controller.enqueue({
                type: 'tool-call',
                toolCallId: 'retry-history',
                toolName: 'shell',
                input: JSON.stringify(request),
              })
            controller.enqueue({
              type: 'finish',
              finishReason: {
                unified: emitRequest ? 'tool-calls' : 'stop',
                raw: undefined,
              },
              usage: {
                inputTokens: {
                  total: 1,
                  noCache: 1,
                  cacheRead: 0,
                  cacheWrite: 0,
                },
                outputTokens: { total: 1, text: 1, reasoning: 0 },
              },
            })
            controller.close()
          },
        }),
      }),
    })
    const options = {
      model,
      tools,
      toolApproval: shellApprovalPolicy(tools),
      onError: () => {},
    }
    const pending = streamText({ ...options, prompt: 'Request a retry.' })
    const parts = await Array.fromAsync(pending.fullStream)
    const prompt = parts.find((part) => part.type === 'tool-approval-request')
    if (!prompt) throw new Error('No retry approval was requested')
    expect(await readFile(join(sandbox, 'history-starts'), 'utf8')).toBe('x')
    emitRequest = false
    const resume = async (approved: boolean) => {
      const history = await pending.response
      const result = streamText({
        ...options,
        messages: [
          ...history.messages,
          {
            role: 'tool',
            content: [
              {
                type: 'tool-approval-response',
                approvalId: prompt.approvalId,
                approved,
              },
            ],
          },
        ],
      })
      await result.consumeStream()
    }
    await resume(false)
    expect(await readFile(join(sandbox, 'history-starts'), 'utf8')).toBe('x')
    await resume(true)
    expect(await readFile(join(sandbox, 'history-starts'), 'utf8')).toBe('xx')
    await resume(true)
    expect(await readFile(join(sandbox, 'history-starts'), 'utf8')).toBe('xx')
  })

  test('a successful probe has no retry and a stale revision cannot spend an approval', async () => {
    const command = '/bin/cat ../outside >/dev/null 2>&1 || true'
    const ok = await execute({ command }, 'tolerated')
    expect(ok.exitCode).toBe(0)
    expect(ok.retryCwd).toBeUndefined()
    const request = {
      command,
      cwd: sandbox,
      description: 'Read the fixture',
      retry: { jobId: String(ok.jobNumber), access: 'filesystem' as const },
    }
    await expect(approveRequest(request, 'unused')).rejects.toThrow(
      'failed shell job',
    )
    request.command = '/bin/cat ../outside >/dev/null 2>&1 || exit 42'
    const failed = await execute({ command: request.command }, 'stale')
    expect(failed.exitCode).toBe(42)
    expect(failed.retryCwd).toBe(sandbox)
    expect(failed.text.trim()).toBe('')
    request.retry.jobId = String(failed.jobNumber)
    expect(await approveRequest(request, 'stale-approval')).toBe(
      'user-approval',
    )
    await expect(
      execute(
        { ...request, retry: { ...request.retry, access: 'both' } },
        'stale-approval',
      ),
    ).rejects.toThrow('expired')
    await expect(
      approveRequest({ ...request, command: 'echo changed' }, 'other-command'),
    ).rejects.toThrow('invocation')
    context.workspace!.revision = 2
    try {
      await expect(execute(request, 'stale-approval')).rejects.toThrow(
        'workspace has changed',
      )
    } finally {
      context.workspace!.revision = 1
    }
  })
})
