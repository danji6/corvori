import { type ShellOptionSpec, parseShellOptionArgs } from './shellOptionArgs'

const DIFF_SWITCHES = [
  '-a',
  '-b',
  '-p',
  '-s',
  '-w',
  '-z',
  '--binary',
  '--cached',
  '--check',
  '--compact-summary',
  '--exit-code',
  '--full-index',
  '--ignore-all-space',
  '--ignore-blank-lines',
  '--ignore-space-at-eol',
  '--ignore-space-change',
  '--minimal',
  '--name-only',
  '--name-status',
  '--no-color',
  '--no-ext-diff',
  '--no-patch',
  '--no-prefix',
  '--no-renames',
  '--no-textconv',
  '--numstat',
  '--patch',
  '--patch-with-stat',
  '--patience',
  '--quiet',
  '--raw',
  '--shortstat',
  '--staged',
  '--summary',
  '--no-color-moved',
]

const DIFF_DATA = [
  '-G',
  '-S',
  '--diff-algorithm',
  '--diff-filter',
  '--dst-prefix',
  '--inter-hunk-context',
  '--src-prefix',
  '--stat-count',
  '--stat-width',
  '--word-diff-regex',
]

const DIFF_OPTIONAL = [
  '-B',
  '-C',
  '-M',
  '-U',
  '--color',
  '--color-moved',
  '--dirstat',
  '--find-copies',
  '--find-renames',
  '--ignore-submodules',
  '--relative',
  '--stat',
  '--submodule',
  '--unified',
  '--word-diff',
]

const DIFF_FILES = ['-O', '--output']
const EXTERNAL_DIFF_OPTIONS = ['--ext-diff', '--textconv']
const LS_FILES_PATHS = ['-X', '--exclude-from', '--exclude-per-directory']
const PATH_OPTIONS = new Set([...DIFF_FILES, ...LS_FILES_PATHS, '--relative'])

const DIFF_OPTIONS: ShellOptionSpec = {
  switches: new Set([...DIFF_SWITCHES, ...EXTERNAL_DIFF_OPTIONS, '--no-index']),
  required: new Set([...DIFF_DATA, ...DIFF_FILES]),
  optional: new Set(DIFF_OPTIONAL),
}

const HISTORY_OPTIONS: ShellOptionSpec = {
  switches: new Set([
    ...DIFF_SWITCHES,
    ...EXTERNAL_DIFF_OPTIONS,
    '--all',
    '--ancestry-path',
    '--date-order',
    '--first-parent',
    '--graph',
    '--log-size',
    '--merges',
    '--no-decorate',
    '--no-merges',
    '--oneline',
    '--reverse',
    '--topo-order',
  ]),
  required: new Set([
    ...DIFF_OPTIONS.required,
    '-n',
    '--after',
    '--author',
    '--before',
    '--committer',
    '--date',
    '--grep',
    '--max-count',
    '--since',
    '--since-as-filter',
    '--skip',
    '--until',
  ]),
  optional: new Set([
    ...DIFF_OPTIONAL,
    '--abbrev',
    '--decorate',
    '--format',
    '--no-walk',
    '--pretty',
  ]),
  legacyCount: true,
}

const INSPECTION_OPTIONS = new Map<string, ShellOptionSpec>([
  ['diff', DIFF_OPTIONS],
  ['log', HISTORY_OPTIONS],
  ['show', HISTORY_OPTIONS],
  [
    'status',
    {
      switches: new Set([
        '-b',
        '-s',
        '-v',
        '-z',
        '--ahead-behind',
        '--branch',
        '--long',
        '--no-ahead-behind',
        '--no-renames',
        '--short',
        '--show-stash',
        '--verbose',
      ]),
      required: new Set(),
      optional: new Set([
        '-M',
        '-u',
        '--column',
        '--find-renames',
        '--ignored',
        '--ignore-submodules',
        '--porcelain',
        '--untracked-files',
      ]),
    },
  ],
  [
    'ls-files',
    {
      switches: new Set([
        '-c',
        '-d',
        '-i',
        '-m',
        '-o',
        '-s',
        '-t',
        '-u',
        '-v',
        '-z',
        '--cached',
        '--deleted',
        '--directory',
        '--exclude-standard',
        '--full-name',
        '--ignored',
        '--modified',
        '--others',
        '--stage',
        '--unmerged',
        '--error-unmatch',
        '--recurse-submodules',
      ]),
      required: new Set([
        '-x',
        ...LS_FILES_PATHS,
        '--exclude',
        '--format',
        '--with-tree',
      ]),
      optional: new Set(),
    },
  ],
  [
    'rev-parse',
    {
      switches: new Set([
        '-q',
        '--absolute-git-dir',
        '--git-common-dir',
        '--git-dir',
        '--is-bare-repository',
        '--is-inside-git-dir',
        '--is-inside-work-tree',
        '--quiet',
        '--show-cdup',
        '--show-prefix',
        '--show-toplevel',
        '--verify',
      ]),
      required: new Set(['--path-format']),
      optional: new Set(['--abbrev-ref', '--short']),
    },
  ],
])

/** Classify recognized Git options while retaining ambiguous file operands. */
export function gitInspectionArgs(command: string | undefined, args: string[]) {
  const spec = command && INSPECTION_OPTIONS.get(command)
  if (!spec) return null

  const parsed = parseShellOptionArgs(args, spec)
  const paths = parsed.options.flatMap(({ flag, value }) => {
    if (value === undefined || !PATH_OPTIONS.has(flag)) return []
    return [value === '-' ? './-' : value]
  })
  const verifiesRef =
    command === 'rev-parse' &&
    parsed.options.some(({ flag }) => flag === '--verify')
  const history = command === 'log' || command === 'show'
  const firstPath = history ? (parsed.operandBoundary ?? 0) : 0
  if (!verifiesRef) paths.push(...parsed.operands.slice(firstPath))

  const external = parsed.options.some(({ flag }) =>
    EXTERNAL_DIFF_OPTIONS.includes(flag),
  )
  const indirect = parsed.options.some(
    ({ flag }) => flag === '--exclude-per-directory',
  )
  const writes = parsed.options.some(({ flag }) => flag === '--output')
  const complete = parsed.complete && !indirect
  return { values: paths, complete, readOnly: complete && !external && !writes }
}
