import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { prepareShellLaunch } from '@cv/sidecar/shell/launch'
import { execFile } from 'node:child_process'
import console from 'node:console'
import { randomUUID } from 'node:crypto'
import {
  copyFile,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { promisify } from 'node:util'

import { offlinePolicy } from './policy.mjs'

const exec = promisify(execFile)
const fixture = await realpath(
  await mkdtemp(join(tmpdir(), 'corvori-shell-perf-')),
)
const originalCwd = process.cwd()
const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/bash'
const policy = offlinePolicy(fixture)
const scenarios = [
  ['builtin', 'echo ok'],
  ['node', 'node workload.mjs write output.txt'],
  ['file scan', 'node workload.mjs scan'],
]
const samples = 20

async function prepare(mode, command) {
  if (mode === 'host')
    return prepareShellLaunch({ command, cwd: fixture, shell })
  const {
    argv: [file, ...args],
    env,
  } = await SandboxManager.wrapWithSandboxArgv(
    shell === '/bin/bash' ? 'exec /bin/bash -lc "' + command + '"' : command,
    shell,
    undefined,
    undefined,
    fixture,
    { commandId: randomUUID() },
  )
  return { file, args, env }
}

async function measure(mode, command) {
  const start = performance.now()
  if (mode === 'cold') await SandboxManager.initialize(policy, undefined, true)
  try {
    const wrapStart = performance.now()
    const { file, args, env } = await prepare(mode, command)
    const prepared = performance.now()
    await exec(file, args, {
      cwd: fixture,
      env,
      timeout: 30_000,
      windowsHide: true,
    })
    return {
      total: performance.now() - start,
      preparation: prepared - wrapStart,
    }
  } finally {
    if (mode === 'cold') await SandboxManager.reset()
  }
}

function percentile(values, fraction) {
  return values
    .toSorted((a, b) => a - b)
    [Math.ceil(values.length * fraction) - 1].toFixed(1)
}

async function report(mode, name, command) {
  const timings = []
  for (let i = 0; i < samples; i++) timings.push(await measure(mode, command))
  const totals = timings.map((t) => t.total)
  const prep = timings.map((t) => t.preparation)
  console.log(
    [
      name,
      mode,
      percentile(totals, 0.5),
      percentile(totals, 0.95),
      percentile(prep, 0.5),
      percentile(prep, 0.95),
    ].join('\t'),
  )
}

try {
  // The benchmark is built into this package's node_modules for Node execution.
  await copyFile(
    join(originalCwd, 'workload.mjs'),
    join(fixture, 'workload.mjs'),
  )
  process.chdir(fixture)
  await exec('git', ['init', '--quiet'], { cwd: fixture })
  for (let i = 0; i < 64; i++) {
    const dir = join(fixture, 'tree', String(i))
    await mkdir(dir, { recursive: true })
    await Promise.all(
      Array.from({ length: 64 }, (_, j) =>
        writeFile(join(dir, String(j)), 'fixture'),
      ),
    )
  }
  console.log('workload\tmode\tmedian ms\tp95 ms\twrap median ms\twrap p95 ms')
  for (const mode of ['host', 'cold', 'warm']) {
    if (mode === 'warm')
      await SandboxManager.initialize(policy, undefined, true)
    for (const [name, command] of scenarios) await report(mode, name, command)
  }
} finally {
  try {
    await SandboxManager.reset()
  } finally {
    process.chdir(originalCwd)
    await rm(fixture, { recursive: true, force: true })
  }
}
