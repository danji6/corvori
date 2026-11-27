import { execFile } from 'node:child_process'
import { readdir, realpath } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const dependencies = new Set(['node_modules', '.venv'])

/** Resolve Git's effective exclusions immediately before preparing a job. */
export async function snapshotGitPaths(directory: string) {
  const root = await realpath(directory)
  const { stdout } = await execute(
    'git',
    [
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.untrackedCache=false',
      'ls-files',
      '--others',
      '--ignored',
      '--exclude-standard',
      '--directory',
      '-z',
    ],
    {
      cwd: root,
      maxBuffer: 16 * 1024 * 1024,
      encoding: 'buffer',
      timeout: 30_000,
    },
  )
  const names = new TextDecoder('utf-8', {
    fatal: true,
    ignoreBOM: true,
  }).decode(stdout)
  const hidden = new Set<string>()
  const readOnly = new Set<string>()
  for (const name of names.split('\0').filter(Boolean)) {
    const entry = resolve(root, name)
    if (!entry.startsWith(root.endsWith(sep) ? root : root + sep)) {
      throw new Error('Git returned an ignored path outside the workspace')
    }
    if (name.endsWith('/') && dependencies.has(basename(entry))) {
      readOnly.add(entry)
    } else {
      hidden.add(entry)
    }
  }

  await collectProtectedEntries(root, hidden, readOnly)
  return { hidden: [...hidden], readOnly: [...readOnly] }
}

/** Skip ignored trees, dependency contents, and directory links during discovery. */
async function collectProtectedEntries(
  root: string,
  hidden: Set<string>,
  readOnly: Set<string>,
) {
  const pending = [root]
  while (pending.length) {
    const directory = pending.pop()!
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.name === '.git') hidden.add(path)
      if (entry.name === '.gitignore') readOnly.add(path)
      if (!entry.isDirectory() || hidden.has(path)) continue
      if (dependencies.has(entry.name)) readOnly.add(path)
      else pending.push(path)
    }
  }
}
