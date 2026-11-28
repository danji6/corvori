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
    const job = await preparePreview(
      {
        sessionId: 'probe',
        workspaceId: 'probe',
        cwd,
        command:
          'printf ready > probe && ! /bin/cat ../private && /bin/cat probe',
      },
      [cwd],
    )
    try {
      const { file, args, env } = job.prepared
      const { stdout } = await execute(file, args, { cwd, env, timeout: 10000 })
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
