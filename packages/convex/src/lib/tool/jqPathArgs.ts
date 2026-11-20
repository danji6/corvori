import { type ShellOptionSpec, parseShellOptionArgs } from './shellOptionArgs'

const QUERY_OPTIONS: ShellOptionSpec = {
  switches: new Set([
    ...[...'RrsncaCSMje'].map((flag) => `-${flag}`),
    '--ascii-output',
    '--color-output',
    '--compact-output',
    '--exit-status',
    '--join-output',
    '--monochrome-output',
    '--null-input',
    '--raw-input',
    '--raw-output',
    '--seq',
    '--slurp',
    '--sort-keys',
    '--stream',
    '--unbuffered',
  ]),
  required: new Set(['--indent']),
}

const SELECTOR =
  /^\.(?:[A-Za-z_]\w*\??)?(?:(?:\.[A-Za-z_]\w*|\[(?:-?\d+)?\]|\["[\w .-]+"\])\??)*(?:\s*\/\/\s*empty)?$/

/** Recognize projections that only operate on jq's explicit inputs. */
export function jqQueryPaths(args: string[]): string[] | null {
  const { operands, complete } = parseShellOptionArgs(args, QUERY_OPTIONS)
  const [filter, ...files] = operands
  if (!complete || !filter) return null
  const projections = filter.split(/\s*\|\s*/)
  return projections.every((part) => SELECTOR.test(part)) ? files : null
}
