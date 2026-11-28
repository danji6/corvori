import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { preparePreview } from './preview'
import { previewAvailable } from './preview-platform'

const execute = promisify(execFile)
let readiness: Promise<boolean> | undefined

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
      return stdout === 'ready'
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
    return Promise.resolve(false)
  }
  return (readiness ??= probe().catch(() => false))
}
