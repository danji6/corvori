import { directShellWords } from '@cv/core/shell/direct-command'
import { execFile } from 'node:child_process'
import { copyFile, lstat, mkdir, symlink } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'

import { isOutside } from '../../mcp/workspace/access'
import { shellWord } from '../launch'

const execute = promisify(execFile)
const flags: Record<string, RegExp> = {
  status: /^(?:--short|--porcelain(?:=v[12])?|--branch|--show-stash|-[sbz]+)$/,
  log: /^(?:--oneline|--all|--decorate|--no-decorate|--max-count=\d+|-\d+)$/,
  diff: /^(?:--stat|--name-only|--name-status|--cached|--staged|--check|--shortstat)$/,
  branch: /^(?:--show-current|--list|--all|-[arl]+)$/,
  'ls-files': /^(?:--stage|--cached|--modified|--deleted|-z)$/,
  'rev-parse': /^(?:HEAD|--show-toplevel|--abbrev-ref|--short)$/,
}

async function linkMetadata(source: string, destination: string, name: string) {
  const file = join(source, name)
  const entry = await lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
  })
  if (!entry || entry.isSymbolicLink()) return
  const target = join(destination, name)
  if (name === 'HEAD') {
    if (!entry.isFile() || entry.size > 4096)
      throw new Error('Invalid Git HEAD')
    await copyFile(file, target)
  } else await symlink(file, target)
}

/** Give a direct inspection command a read-only Git view with no repository-configured helpers. */
export async function prepareGitQuery(
  command: string,
  cwd: string,
  roots: string[],
  temporary: string,
  git: string,
) {
  const words = directShellWords(command)
  if (words?.[0] !== 'git') return
  const [subcommand, ...args] = words.slice(1)
  const allowed = Object.hasOwn(flags, subcommand) && flags[subcommand]
  if (!allowed || args.some((arg) => !allowed.test(arg))) return
  const info = await execute(
    git,
    [
      'rev-parse',
      '--show-toplevel',
      '--absolute-git-dir',
      '--path-format=absolute',
      '--git-common-dir',
    ],
    {
      cwd,
      env: {
        PATH: '/usr/bin:/bin',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
      },
    },
  ).catch(() => undefined)
  if (!info) return
  const paths = info.stdout.trimEnd().split('\n')
  if (paths.length !== 3 || paths.some((path) => !isAbsolute(path))) return
  const [worktree, metadata, common] = paths
  if (!roots.some((root) => !isOutside(root, worktree))) return
  const view = join(temporary, 'git-view')
  await mkdir(view)
  await Promise.all([
    ...['HEAD', 'index'].map((name) => linkMetadata(metadata, view, name)),
    ...['objects', 'refs', 'packed-refs', 'shallow'].map((name) =>
      linkMetadata(common, view, name),
    ),
  ])
  const argv = [
    git,
    '--no-pager',
    '--no-optional-locks',
    '--git-dir=' + view,
    '--work-tree=' + worktree,
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'core.fsmonitor=false',
    subcommand,
    ...args,
  ]
  return {
    command: 'exec ' + argv.map(shellWord).join(' '),
    view,
    metadata: [metadata, common],
  }
}
