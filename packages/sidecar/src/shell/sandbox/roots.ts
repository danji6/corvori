import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { isOutside } from '../../mcp/workspace/access'
import { linuxPaths } from './preview-platform'
import { systemTools } from './system-tools'

export async function sandboxRoots(roots: string[]) {
  const runtime = await realpath(
    (process.versions.bun && process.env.NODE_BINARY) || process.execPath,
  )
  const installation = await realpath(process.cwd())
  const trusted = [installation, runtime, await realpath(tmpdir())]
  const helpers = ['node_modules', 'packages', 'scripts', 'bin'].map((name) =>
    join(installation, name),
  )
  helpers.push(
    resolve(installation, process.env.CHAT_DATA_DIR || '.data', 'build'),
  )
  const cli = process.env.CORVORI_GH_BINARY
  if (cli) helpers.push(cli, await realpath(cli).catch(() => cli))
  for (const path of [
    '/usr/bin',
    '/bin',
    '/usr/lib',
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/usr/local/Cellar/gh',
    '/opt/homebrew/Cellar/gh',
    ...(await systemTools()).reads,
  ]) {
    helpers.push(path, await realpath(path).catch(() => path))
  }
  if (process.platform === 'linux') helpers.push(...Object.values(linuxPaths()))
  for (const root of roots) {
    if (
      trusted.some((path) => !isOutside(root, path)) ||
      helpers.some((path) => !isOutside(root, path) || !isOutside(path, root))
    )
      throw new Error(
        'A sandbox workspace overlaps the installation or private temporary directory',
      )
  }
  // A cwd below an existing grant must never reopen a protected child.
  return roots.filter(
    (root) => !roots.some((other) => other !== root && !isOutside(other, root)),
  )
}
