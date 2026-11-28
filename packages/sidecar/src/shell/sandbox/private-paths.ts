import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { dataRoot } from '../../agent-files/storage'
import { isOutside } from '../../mcp/workspace/access'
import type { ShellEnvironment } from '../launch'
import { githubConfigDirectory } from './github'

function installationData() {
  return resolve(process.env.CHAT_DATA_DIR || '.data')
}

export function shellJobDirectory() {
  return join(installationData(), 'shell-jobs')
}

/** Keep service state, other jobs and on-disk credentials private even with broad reads. */
export async function privateShellPaths(
  roots: string[],
  env?: ShellEnvironment,
) {
  const data = installationData()
  const sidecar = process.env.CHAT_SIDECAR_DATA_DIR
    ? dataRoot()
    : join(data, 'sidecar')
  const storage = [data, sidecar]
  const credentials = [
    resolve('.env'),
    resolve('.env.local'),
    githubConfigDirectory(),
    ...['.ssh', '.aws', '.git-credentials'].map((name) =>
      join(homedir(), name),
    ),
  ]
  const hidden = []
  for (const path of [...storage, ...credentials]) {
    const canonical = await realpath(path).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
      },
    )
    if (!canonical) continue
    for (const root of roots) {
      if (isOutside(canonical, root)) continue
      const personal = [env?.SESSION_DIR, env?.AGENT_DIR].some(
        (dir) => dir && !isOutside(dir, root),
      )
      if (!storage.includes(path) || !personal || !isOutside(root, canonical))
        throw new Error(
          'A sandbox workspace overlaps private Corvori storage or credentials',
        )
    }
    hidden.push(canonical)
  }
  return [...new Set(hidden)]
}
