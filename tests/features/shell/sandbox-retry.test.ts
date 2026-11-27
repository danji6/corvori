import { approvalHold } from '@cv/convex/lib/tool/approvalPolicy'
import type { WorkspaceToolContext } from '@cv/convex/model/tool/context'
import type { ShellJobInput } from '@cv/convex/model/tool/shell'
import { shellApprovalPolicy } from '@cv/convex/model/tool/shellApproval'
import { createShellTool } from '@cv/convex/model/tool/shellTools'
import {
  approvalRememberOption,
  approvalSummary,
} from '@cv/core/approval-presentation'
import type { ShellRetryAccess } from '@cv/core/shell/retry'
import type { ShellToolOutput } from '@cv/core/types/tools'
import type { ToolSet } from 'ai'
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
import { getShellRoutes } from '~/tests/helpers/shell-registry'

describe.skipIf(
  process.platform === 'win32' || process.env.CORVORI_NATIVE_TEST !== '1',
)('native shell retry approval', () => {
  let root: string
  let sandbox: string
  let server: ReturnType<typeof Bun.serve>
  let restore: () => void
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
    const settings = {
      CHAT_SIDECAR_DATA_DIR: join(root, 'sidecar'),
      CORVORI_SHELL_SANDBOX_PREVIEW: '1',
      CHAT_JOB_MODE: 'pipe',
      SIDECAR_URL: '',
    }
    const saved = Object.keys(settings).map(
      (key) => [key, process.env[key]] as const,
    )
    restore = () => {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
    Object.assign(process.env, settings)
    const app = await getShellRoutes()
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (req) =>
        new URL(req.url).pathname === '/fixture'
          ? new Response('ok')
          : app.fetch(req),
    })
    process.env.SIDECAR_URL = 'http://127.0.0.1:' + server.port
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
    restore?.()
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
      const url = process.env.SIDECAR_URL + '/fixture'
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

  test('a successful probe has no retry and a stale revision cannot spend an approval', async () => {
    const command = '/bin/cat ../outside >/dev/null 2>&1 || true'
    const ok = await execute({ command }, 'tolerated')
    expect(ok.exitCode).toBe(0)
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
    request.retry.jobId = String(failed.jobNumber)
    expect(await approveRequest(request, 'stale-approval')).toBe(
      'user-approval',
    )
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
