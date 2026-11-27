import {
  SandboxManager,
  WindowsSandboxError,
} from '@anthropic-ai/sandbox-runtime'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { initializeBackend, workspaceProbePolicy } from './backend'
import { prepareProbeCommand } from './diagnostic-command'

const vendor = resolve(process.argv[2])
const mxcOnly = process.argv.includes('--mxc-only')
const cwd = await realpath(
  await mkdtemp(
    join(process.env.RUNNER_TEMP || tmpdir(), 'corvori-native-check-'),
  ),
)
const original = process.cwd()
try {
  process.chdir(cwd)
  await promisify(execFile)('git', ['init', '--quiet'], { cwd })
  await writeFile('.gitignore', '*.private\n')
  await writeFile('test.private', 'disposable')
  const policy = await workspaceProbePolicy(cwd, vendor)
  const backend = await initializeBackend(policy, mxcOnly)
  const launch = await prepareProbeCommand({
    command: 'echo ready',
    commandId: randomUUID(),
    cwd,
    shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
    filesystem: policy.filesystem,
  })
  const result = await launch()
  if (result.status || result.stdout.trim() !== 'ready')
    throw new Error('Native command did not complete')
  console.log(
    JSON.stringify({
      version: 1,
      backend,
      probe: 'passed',
      automaticShellExecution: false,
    }),
  )
} catch (error) {
  const unsupported =
    error instanceof WindowsSandboxError && error.code === 'backend_unsupported'
  console.error(error instanceof Error ? error.message : 'Sandbox check failed')
  process.exitCode = mxcOnly && unsupported ? 78 : 1
} finally {
  try {
    await SandboxManager.reset()
  } finally {
    process.chdir(original)
    await rm(cwd, { recursive: true, force: true })
  }
}
