import {
  SandboxManager,
  WindowsSandboxError,
} from '@anthropic-ai/sandbox-runtime'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { initializeBackend, workspaceProbePolicy } from './backend'
import { prepareProbeCommand } from './diagnostic-command'
import { sandboxReady } from './readiness'

const vendor = resolve(process.argv[2])
process.env.PATH =
  dirname(process.execPath) + delimiter + (process.env.PATH ?? '')
const mxcOnly = process.argv.includes('--mxc-only')
const cwd = await realpath(
  await mkdtemp(
    join(process.env.RUNNER_TEMP || tmpdir(), 'corvori-native-check-'),
  ),
)
const automaticShellExecution = await sandboxReady()
const original = process.cwd()
try {
  process.chdir(cwd)
  await promisify(execFile)('git', ['init', '--quiet'], { cwd })
  await writeFile('.gitignore', '*.private\n')
  await writeFile('test.private', 'disposable')
  await writeFile(
    'check.cjs',
    [
      "const fs = require('node:fs')",
      "fs.writeFileSync('output', 'ready')",
      "try { if (fs.readFileSync('test.private', 'utf8') === 'disposable') process.exitCode = 1 }",
      "catch (error) { if (!['EACCES', 'EPERM', 'ENOENT'].includes(error.code)) throw error }",
    ].join('\n'),
  )
  const policy = await workspaceProbePolicy(cwd, vendor)
  const backend = await initializeBackend(policy, mxcOnly)
  const launch = await prepareProbeCommand({
    command: 'node check.cjs',
    commandId: randomUUID(),
    cwd,
    shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
    filesystem: policy.filesystem,
  })
  const result = await launch()
  if (result.status || (await readFile('output', 'utf8')) !== 'ready') {
    throw new Error(
      'The native workspace write and protected read check failed',
    )
  }
  console.log(
    JSON.stringify({
      version: 1,
      backend,
      probe: 'passed',
      automaticShellExecution,
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
