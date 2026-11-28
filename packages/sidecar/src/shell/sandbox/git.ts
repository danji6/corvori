import { directShellWords } from '@cv/core/shell/direct-command'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { shellWord } from '../launch'

const flags: Record<string, RegExp> = {
  status: /^(?:--short|--porcelain(?:=v[12])?|--branch|--show-stash|-[sbz]+)$/,
  log: /^(?:--oneline|--all|--decorate|--no-decorate|--max-count=\d+|-\d+)$/,
  diff: /^(?:--stat|--name-only|--name-status|--cached|--staged|--check|--shortstat)$/,
  branch: /^(?:--show-current|--list|--all|-[arl]+)$/,
  'ls-files': /^(?:--stage|--cached|--modified|--deleted|-z)$/,
  'rev-parse': /^(?:HEAD|--show-toplevel|--abbrev-ref|--short)$/,
}

/** Run recognized inspections directly with an entirely read-only workspace. */
export async function prepareGitQuery(
  command: string,
  git: string,
  cwd: string,
) {
  const words = directShellWords(command)
  if (words?.[0] !== 'git') return
  const [subcommand, ...args] = words.slice(1)
  const allowed = Object.hasOwn(flags, subcommand) && flags[subcommand]
  if (!allowed || args.some((arg) => !allowed.test(arg))) return
  // Git for Windows may rediscover a different worktree inside a ProcessContainer.
  // Use Git's own discovery from the original cwd, including linked worktrees.
  const location =
    process.platform === 'win32'
      ? await promisify(execFile)(
          git,
          ['rev-parse', '--absolute-git-dir', '--show-toplevel'],
          { cwd, timeout: 5000 },
        ).catch(() => undefined)
      : undefined
  const [metadata, worktree] = location?.stdout.trimEnd().split(/\r?\n/) ?? []
  const argv = [
    git,
    '--no-pager',
    '--no-optional-locks',
    ...(metadata && worktree
      ? [
          '--git-dir=' + metadata,
          '--work-tree=' + worktree,
          '-c',
          'core.bare=false',
        ]
      : []),
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'core.fsmonitor=false',
    subcommand,
    ...args,
  ]
  return {
    argv,
    command: 'exec ' + argv.map(shellWord).join(' '),
  }
}
