import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { preparePreview } from './preview'
import { previewAvailable } from './preview-platform'

const execute = promisify(execFile)
let readiness: Promise<boolean> | undefined
let detail: string | undefined

export function sandboxSetupDetail() {
  return detail
}

/** Verify a real child can write ordinary files while a sibling file stays private. */
async function probe() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'corvori-probe-')))
  const cwd = join(root, 'workspace')
  try {
    await mkdir(cwd)
    await writeFile(join(root, 'private'), 'private')
    const windows = process.platform === 'win32'
    if (windows) {
      await writeFile(
        join(cwd, 'probe.cjs'),
        [
          "const fs = require('node:fs')",
          "fs.writeFileSync('probe', 'ready')",
          "try { fs.readFileSync('../private'); process.exitCode = 1 }",
          "catch (error) { if (!['EPERM', 'EACCES', 'ENOENT'].includes(error.code)) throw error }",
          "process.stdout.write(fs.readFileSync('probe'))",
        ].join('\n'),
      )
    }
    const job = await preparePreview(
      {
        sessionId: 'probe',
        workspaceId: 'probe',
        cwd,
        shell: windows ? 'cmd.exe' : undefined,
        command: windows
          ? 'node probe.cjs'
          : 'printf ready > probe && ! /bin/cat ../private && /bin/cat probe',
      },
      [cwd],
    )
    try {
      const { file, args, env } = job.prepared
      const { stdout } = await execute(file, args, {
        cwd: job.prepared.cwd ?? cwd,
        env,
        timeout: 15000,
      })
      if (stdout !== 'ready')
        throw new Error('Workspace probe did not return its expected output')
      return true
    } finally {
      await job.cleanup()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

export function sandboxReady() {
  if (!previewAvailable()) {
    readiness = undefined
    detail = 'The packaged workspace sandbox is unavailable on this host'
    return Promise.resolve(false)
  }
  return (readiness ??= probe().catch((error: unknown) => {
    // Only this fixed, credential-free startup probe can supply diagnostic output.
    detail =
      error instanceof Error
        ? error.message.slice(0, 1800)
        : 'Sandbox startup check failed'
    return false
  }))
}
