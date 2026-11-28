import { analyzeShellPathCandidates } from '@cv/convex/lib/tool/approval'
import { withApprovalPaths } from '@cv/convex/model/stream/engineApproval'
import type { WorkspaceToolContext } from '@cv/convex/model/tool/context'
import { createShellTool } from '@cv/convex/model/tool/shellTools'
import type { ShellToolOutput } from '@cv/core/types/tools'
import { ensureSessionDirectory } from '@cv/sidecar/session-files/storage'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createTempDirectory } from '~/tests/helpers/temp-directory'

let base: string
let sessionRoot: string
let context: WorkspaceToolContext
let server: ReturnType<typeof Bun.serve>
const previous = {
  CHAT_SIDECAR_DATA_DIR: process.env.CHAT_SIDECAR_DATA_DIR,
  SIDECAR_URL: process.env.SIDECAR_URL,
}

function restoreEnvironment(previous: Record<string, string | undefined>) {
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}

async function createFixture() {
  base = await createTempDirectory('shell-session-dir-')
  const project = path.join(base, 'project')
  await mkdir(path.join(project, 'src'), { recursive: true })
  await writeFile(path.join(project, 'Nuke Sim.html'), 'fixture\n')
  process.env.CHAT_SIDECAR_DATA_DIR = path.join(base, "session's data")
  sessionRoot = await ensureSessionDirectory('shell-session-dir')
  await writeFile(path.join(sessionRoot, 'Nuke Sim.original.html'), 'fixture\n')
  context = {
    sessionId: 'shell-session-dir',
    ownerId: 'shell-session-dir',
    workspaceId: 'project',
    workspace: {
      workspaceId: 'project',
      label: 'Fixture',
      path: project,
      sources: [{ id: 'project', path: project, label: 'Fixture' }],
      sessionFiles: true,
    },
  } as WorkspaceToolContext
}

async function needsApproval(
  command: string,
  overrides: Partial<WorkspaceToolContext> = {},
  cwd?: string,
) {
  const tool = await createShellTool({ ...context, ...overrides })
  const predicate = tool.needsApproval as (input: {
    command: string
    cwd?: string
  }) => Promise<boolean>
  return predicate({ command, cwd })
}

function approvalPreview(
  command: string,
  overrides: Partial<WorkspaceToolContext> = {},
  cwd?: string,
) {
  return withApprovalPaths(
    { ...context, ...overrides },
    {
      type: 'tool-shell',
      state: 'approval-requested',
      toolCallId: 'test',
      approval: { id: 'test' },
      input: { command, cwd },
    },
  )
}

describe.skipIf(process.platform === 'win32')(
  'Bash session directory approval',
  () => {
    beforeAll(async () => {
      await createFixture()
      const { createApp } = await import('@cv/sidecar/main')
      const app = createApp(async (_c, next) => next())
      server = Bun.serve({ port: 0, fetch: app.fetch })
      process.env.SIDECAR_URL = `http://localhost:${server.port}`
    })

    afterAll(async () => {
      server?.stop(true)
      restoreEnvironment(previous)
      await rm(base, { recursive: true, force: true })
    })

    test('checks the reported build and comparison across project and session roots', async () => {
      const command = String.raw`npm run build && cmp -- 'Nuke Sim.html' "$SESSION_DIR/Nuke Sim.original.html" && sha256sum 'Nuke Sim.html'`
      const approved = { approvals: async () => ({ shell: ['npm run build'] }) }
      expect(analyzeShellPathCandidates(command)).toEqual({
        candidates: ['Nuke Sim.html'],
        sessionPaths: ['Nuke Sim.original.html'],
        complete: true,
      })
      expect(await needsApproval(command)).toBe(true)
      expect(await needsApproval(command, approved)).toBe(false)
      expect(await approvalPreview(command)).toMatchObject({
        approvalPathStatus: null,
      })
      expect(
        await approvalPreview(command, { shell: '/bin/sh' }),
      ).toMatchObject({ approvalPathStatus: 'analysis' })
      const workspace = { ...context.workspace!, sessionFiles: false }
      expect(await approvalPreview(command, { workspace })).toMatchObject({
        approvalPathStatus: 'analysis',
      })
    })

    test('applies ignore and canonical path grants to literal session filenames', async () => {
      expect(Bun.spawnSync(['git', 'init', '-q', sessionRoot]).exitCode).toBe(0)
      const ignored = path.join(sessionRoot, 'private.html')
      const otherSession = await ensureSessionDirectory('other-session')
      const external = path.join(otherSession, 'private.html')
      await writeFile(path.join(sessionRoot, '.gitignore'), 'private.html\n')
      await writeFile(ignored, 'fixture')
      await writeFile(external, 'outside this session')
      await writeFile(path.join(sessionRoot, 'file1.html'), 'fixture')
      await symlink(external, path.join(sessionRoot, 'file[1].html'))
      const cwd = 'workspace://src'
      const command =
        'cmp -- "${SESSION_DIR}/file[1].html" "$SESSION_DIR/private.html"'
      expect(await approvalPreview(command, {}, cwd)).toMatchObject({
        approvalPathStatus: 'paths',
        approvalPaths: [external, ignored],
      })
      expect(await needsApproval(command, {}, cwd)).toBe(true)
      const approved = {
        approvals: async () => ({ paths: [external, ignored] }),
      }
      expect(await needsApproval(command, approved, cwd)).toBe(false)
      expect(
        await needsApproval(
          'cat -- "$SESSION_DIR/../other-session/private.html"',
        ),
      ).toBe(true)
    })

    test.each([
      'cat $SESSION_DIR/file',
      "cat '$SESSION_DIR/file'",
      'cat "\\$SESSION_DIR/file"',
      'cat "${SESSION_DIR:-/tmp}/file"',
      'cat "$SESSION_DIR/$name"',
      'SESSION_DIR=/tmp cat "$SESSION_DIR/file"',
      'unset SESSION_DIR; cat "$SESSION_DIR/file"',
    ])('requires approval for an unverified binding in %s', async (command) => {
      expect(analyzeShellPathCandidates(command).sessionPaths).toBeUndefined()
      expect(
        await needsApproval(command, {
          approvals: async () => ({ shell: ['unset'] }),
        }),
      ).toBe(true)
      expect(await approvalPreview(command)).toMatchObject({
        approvalPathStatus: 'analysis',
      })
    })

    test('only resolves the operand that actually expands the directory', async () => {
      const command = `cmp -- "$SESSION_DIR/file" '$SESSION_DIR/file'`
      expect(analyzeShellPathCandidates(command)).toEqual({
        candidates: ['$SESSION_DIR/file'],
        sessionPaths: ['file'],
        complete: true,
      })
      expect(await needsApproval(command)).toBe(true)
    })

    test('uses the checked value after Bash startup when executing an approved command', async () => {
      const startup = path.join(base, 'bash-startup')
      await writeFile(startup, 'SESSION_DIR=/wrong-session\n')
      const previous = {
        BASH_ENV: process.env.BASH_ENV,
        CHAT_JOB_MODE: process.env.CHAT_JOB_MODE,
      }
      const tool = await createShellTool(context)
      process.env.BASH_ENV = startup
      try {
        const modes =
          process.platform === 'linux'
            ? ['pipe', 'script', 'pty']
            : ['pipe', 'pty']
        for (const mode of modes) {
          process.env.CHAT_JOB_MODE = mode
          const command = 'cat -- "${SESSION_DIR}/Nuke Sim.original.html"'
          expect(await needsApproval(command)).toBe(false)
          const outputs = await tool.execute!(
            { command, wait_seconds: 2 },
            { toolCallId: 'test', messages: [], context: undefined as never },
          )
          let result: ShellToolOutput | undefined
          for await (const output of outputs as AsyncIterable<ShellToolOutput>)
            result = output
          expect(result).toMatchObject({
            status: 'done',
            exitCode: 0,
            text: 'fixture\n',
          })
        }
      } finally {
        restoreEnvironment(previous)
      }
    })
  },
)
