import { execFile } from 'node:child_process'
import { readdir, realpath } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

import { systemTools } from './system-tools'

const execute = promisify(execFile)
const dependencies = new Set(['node_modules', '.venv'])

/** Resolve Git's effective exclusions immediately before preparing a job. */
export async function snapshotGitPaths(directory: string, emptyRepo?: string) {
  const root = await realpath(directory)
  const hidden = new Set<string>()
  const readOnly = new Set<string>()
  let gitArgs: string[] = []
  if (emptyRepo) {
    const { git } = await systemTools()
    try {
      await execute(git, ['rev-parse', '--git-dir'], {
        cwd: root,
        env: { ...process.env, LC_ALL: 'C' },
        timeout: 10000,
      })
    } catch (error) {
      if (
        !(error as { stderr?: string }).stderr?.includes('not a git repository')
      )
        throw error
      gitArgs = ['--git-dir', emptyRepo, '--work-tree', root]
    }
  }
  await addIgnoredPaths(root, hidden, readOnly, gitArgs)
  await collectProtectedEntries(root, hidden, readOnly)
  return {
    hidden: [...hidden],
    readOnly: [...readOnly],
  }
}

async function addIgnoredPaths(
  root: string,
  hidden: Set<string>,
  readOnly: Set<string>,
  gitArgs: string[] = [],
) {
  const { git } = await systemTools()
  const { stdout } = await execute(
    git,
    [
      ...gitArgs,
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
}

/** Locate both the worktree index and the shared repository behind a .git file. */
async function addLinkedMetadata(directory: string, readOnly: Set<string>) {
  const { git } = await systemTools()
  const { stdout } = await execute(
    git,
    ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'],
    { cwd: directory, timeout: 10_000 },
  )
  const paths = stdout.replace(/\r?\n$/, '').split(/\r?\n/)
  if (paths.length !== 2 || !paths.every(isAbsolute))
    throw new Error('Could not identify linked Git metadata')
  for (const path of paths) readOnly.add(await realpath(path))
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
    const metadata = entries.find((entry) => entry.name === '.git')
    if (metadata && directory !== root)
      await addIgnoredPaths(directory, hidden, readOnly)
    if (metadata && !metadata.isDirectory())
      await addLinkedMetadata(directory, readOnly)
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.name === '.git') {
        readOnly.add(path)
        continue
      }
      if (entry.name === '.gitignore') readOnly.add(path)
      if (!entry.isDirectory() || hidden.has(path)) continue
      if (dependencies.has(entry.name)) readOnly.add(path)
      else pending.push(path)
    }
  }
}
