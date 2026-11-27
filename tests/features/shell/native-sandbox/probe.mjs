import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import console from 'node:console'
import { randomUUID } from 'node:crypto'
import {
  copyFile,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { clearTimeout, setTimeout } from 'node:timers'
import { promisify } from 'node:util'

import {
  initializeBackend,
  offlinePolicy,
  prepareProbeCommand,
} from './policy.mjs'

const execute = promisify(execFile)
const workspace = await realpath(
  await mkdtemp(join(process.env.RUNNER_TEMP || tmpdir(), 'corvori-sandbox-')),
)
const originalCwd = process.cwd()
const windows = process.platform === 'win32'
const samples = ['first', 'second']
const ids = samples.map(() => randomUUID())

// Use fixed commands and fixture-only operands. Resolve node through a known PATH.
async function run(command, commandId) {
  const shell = windows ? 'cmd.exe' : '/bin/bash'
  const { filesystem } = await offlinePolicy(workspace)
  const launch = await prepareProbeCommand({
    command,
    commandId,
    cwd: workspace,
    shell,
    filesystem,
  })
  const result = await launch()
  return {
    status: result.status,
    output: result.stdout.trim(),
    diagnostic: result.stderr.trim(),
  }
}

function fileEvent(id, file) {
  const store = SandboxManager.getSandboxViolationStore()
  return store
    .getViolationsForCommand(id)
    .some(
      (event) =>
        event.line.includes(file) && /deny.*file-read/i.test(event.line),
    )
}

async function waitForEvidence() {
  const store = SandboxManager.getSandboxViolationStore()
  const observed = () =>
    samples.every((name, index) => fileEvent(ids[index], name + '.private'))
  let unsubscribe
  let timer
  try {
    await new Promise((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error('Missing job-attributed read denial')),
        5000,
      )
      if (observed()) return resolve()
      unsubscribe = store.subscribe(() => {
        if (observed()) resolve()
      })
    })
  } finally {
    clearTimeout(timer)
    unsubscribe?.()
  }
}

async function checkChildren() {
  const results = await Promise.all(
    samples.map((name, index) =>
      run('node workload.mjs child ' + name + '.private', ids[index]),
    ),
  )
  for (const result of results) {
    assert.equal(result.output, 'read denied', JSON.stringify(result))
    assert.equal(result.status, 42)
  }
  console.log('Protected reads denied in both child processes')
  await waitForEvidence()
  assert.equal(fileEvent(ids[0], 'second.private'), false)
  assert.equal(fileEvent(ids[1], 'first.private'), false)
  console.log('Both read denials attributed to the correct job')
}

try {
  process.chdir(workspace)
  await execute('git', ['init', '--quiet'], { cwd: workspace })
  await copyFile(join(originalCwd, 'workload.mjs'), 'workload.mjs')
  await writeFile('.gitignore', '*.private\n')
  const backend = await initializeBackend(await offlinePolicy(workspace))
  console.log('Selected native backend:', backend)
  // Created AFTER manager initialization. The next invocation must snapshot both files.
  for (const name of samples)
    await writeFile(name + '.private', 'fixture value')
  const result = await run('node workload.mjs write output.txt', randomUUID())
  assert.equal(result.status, 0, JSON.stringify(result))
  assert.equal(await readFile('output.txt', 'utf8'), 'workspace output')
  console.log('Ordinary workspace I/O succeeded')
  await checkChildren()
} finally {
  try {
    await SandboxManager.reset()
  } finally {
    process.chdir(originalCwd)
    await rm(workspace, { recursive: true, force: true })
  }
}
