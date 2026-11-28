import { directShellWords } from '@cv/core/shell/direct-command'

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
export function prepareGitQuery(command: string, git: string) {
  const words = directShellWords(command)
  if (words?.[0] !== 'git') return
  const [subcommand, ...args] = words.slice(1)
  const allowed = Object.hasOwn(flags, subcommand) && flags[subcommand]
  if (!allowed || args.some((arg) => !allowed.test(arg))) return
  const argv = [
    git,
    '--no-pager',
    '--no-optional-locks',
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
