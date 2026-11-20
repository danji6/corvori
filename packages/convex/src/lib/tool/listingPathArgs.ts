import { type ShellOptionSpec, parseShellOptionArgs } from './shellOptionArgs'

const HEAD_OPTIONS: ShellOptionSpec = {
  switches: new Set([
    '-q',
    '-v',
    '-z',
    '--quiet',
    '--silent',
    '--verbose',
    '--zero-terminated',
    '--help',
    '--version',
  ]),
  required: new Set(['-n', '-c', '--lines', '--bytes']),
  legacyCount: true,
}

const LS_OPTIONS: ShellOptionSpec = {
  switches: new Set([
    ...'aAbBcCdDfFgGhHiklLmNnopqQrRsStuvUxXZ1'
      .split('')
      .map((flag) => `-${flag}`),
    '--all',
    '--almost-all',
    '--author',
    '--escape',
    '--directory',
    '--dired',
    '--full-time',
    '--file-type',
    '--group-directories-first',
    '--human-readable',
    '--si',
    '--dereference-command-line',
    '--dereference-command-line-symlink-to-dir',
    '--inode',
    '--kibibytes',
    '--dereference',
    '--numeric-uid-gid',
    '--literal',
    '--hide-control-chars',
    '--show-control-chars',
    '--quote-name',
    '--reverse',
    '--recursive',
    '--size',
    '--context',
    '--zero',
    '--help',
    '--version',
    '--ignore-backups',
  ]),
  required: new Set([
    '-I',
    '-T',
    '-w',
    '--ignore',
    '--hide',
    '--block-size',
    '--format',
    '--indicator-style',
    '--quoting-style',
    '--sort',
    '--time',
    '--time-style',
    '--tabsize',
    '--width',
  ]),
  optional: new Set(['--color', '--hyperlink', '--classify']),
}

type FileOptionSpec = ShellOptionSpec & {
  fileOptions?: readonly string[]
  indirectOptions?: readonly string[]
  outputOptions?: readonly string[]
  dashIsFile?: boolean
}

function switches(short: string, long: string) {
  return new Set([
    ...[...short].map((flag) => `-${flag}`),
    ...long.split(' '),
    '--help',
    '--version',
  ])
}

const DU_FILES = ['-X', '--exclude-from', '--files0-from']
const SORT_OUTPUTS = ['-o', '--output', '-T', '--temporary-directory']
const SORT_FILES = [
  ...SORT_OUTPUTS,
  '--compress-program',
  '--files0-from',
  '--random-source',
]
const TREE_FILES = ['-o', '--infofile']

const FILE_OPTIONS = new Map<string, FileOptionSpec>([
  ['head', HEAD_OPTIONS],
  ['ls', { ...LS_OPTIONS, dashIsFile: true }],
  [
    'tail',
    {
      switches: switches(
        'fFqrvz',
        '--debug --quiet --silent --retry --verbose --zero-terminated',
      ),
      required: new Set([
        '-b',
        '-c',
        '-n',
        '-s',
        '--bytes',
        '--lines',
        '--max-unchanged-stats',
        '--pid',
        '--sleep-interval',
      ]),
      optional: new Set(['--follow']),
      legacyCount: true,
    },
  ],
  [
    'du',
    {
      switches: switches(
        '0aAbcDHhkLlmPShsx',
        '--null --all --apparent-size --bytes --total --dereference-args --human-readable --inodes --dereference --count-links --no-dereference --separate-dirs --si --summarize --one-file-system',
      ),
      required: new Set([
        '-B',
        '-d',
        '-t',
        '--block-size',
        '--max-depth',
        '--threshold',
        '--time-style',
        '--exclude',
        ...DU_FILES,
      ]),
      optional: new Set(['--time']),
      fileOptions: DU_FILES,
      indirectOptions: ['--files0-from'],
      dashIsFile: true,
    },
  ],
  [
    'df',
    {
      switches: switches(
        'aHhiklmPTv',
        '--all --human-readable --si --inodes --local --no-sync --portability --sync --total --print-type',
      ),
      required: new Set([
        '-B',
        '-t',
        '-x',
        '--block-size',
        '--type',
        '--exclude-type',
      ]),
      optional: new Set(['--output']),
      dashIsFile: true,
    },
  ],
  [
    'cut',
    {
      switches: switches(
        'nswz',
        '--complement --no-partial --only-delimited --zero-terminated',
      ),
      required: new Set([
        '-b',
        '-c',
        '-d',
        '-f',
        '-F',
        '-O',
        '--bytes',
        '--characters',
        '--delimiter',
        '--fields',
        '--output-delimiter',
      ]),
      optional: new Set(['--whitespace-delimited']),
    },
  ],
  [
    'nl',
    {
      switches: switches('p', '--no-renumber'),
      required: new Set([
        '-b',
        '-d',
        '-f',
        '-h',
        '-i',
        '-l',
        '-n',
        '-s',
        '-v',
        '-w',
        '--body-numbering',
        '--section-delimiter',
        '--footer-numbering',
        '--header-numbering',
        '--line-increment',
        '--join-blank-lines',
        '--number-format',
        '--number-separator',
        '--starting-line-number',
        '--number-width',
      ]),
    },
  ],
  [
    'sort',
    {
      switches: switches(
        'bdfgiMhnRrVcCmsuz',
        '--ignore-leading-blanks --dictionary-order --ignore-case --general-numeric-sort --ignore-nonprinting --month-sort --human-numeric-sort --numeric-sort --random-sort --reverse --version-sort --debug --merge --stable --unique --zero-terminated',
      ),
      required: new Set([
        '-k',
        '-S',
        '-t',
        '--key',
        '--buffer-size',
        '--field-separator',
        '--sort',
        '--batch-size',
        '--parallel',
        ...SORT_FILES,
      ]),
      optional: new Set(['--check']),
      fileOptions: SORT_FILES,
      indirectOptions: ['--files0-from', '--compress-program'],
      outputOptions: SORT_OUTPUTS,
    },
  ],
  [
    'uniq',
    {
      switches: switches(
        'cdDiuz',
        '--count --repeated --ignore-case --unique --zero-terminated',
      ),
      required: new Set([
        '-f',
        '-s',
        '-w',
        '--skip-fields',
        '--skip-chars',
        '--check-chars',
      ]),
      optional: new Set(['--all-repeated', '--group']),
      legacyCount: true,
    },
  ],
  [
    'tree',
    {
      switches: switches(
        'aACdDfgFhijJlnNpqRrSstuUxX',
        '--dirsfirst --filesfirst --fflinks --fromfile --fromtabfile --gitignore --inodes --device --noreport --nolinks --prune --info --matchdirs --metafirst --du --sortdirs',
      ),
      required: new Set([
        '-H',
        '-I',
        '-L',
        '-P',
        '-T',
        '--charset',
        '--filelimit',
        '--sort',
        '--timefmt',
        ...TREE_FILES,
      ]),
      fileOptions: TREE_FILES,
      indirectOptions: ['-R', '--fromfile', '--fromtabfile'],
      outputOptions: ['-o'],
      dashIsFile: true,
    },
  ],
])

/** Classify file operands and file-valued options for common utilities. */
export function listingPathValues(program: string, args: string[]) {
  const spec = FILE_OPTIONS.get(program)
  if (!spec) return null

  const { operands, options, complete } = parseShellOptionArgs(args, spec)
  const files = options.flatMap(({ flag, value }) => {
    if (value === undefined || !spec.fileOptions?.includes(flag)) return []
    return [value === '-' && flag !== '--files0-from' ? './-' : value]
  })
  const values = [
    ...files,
    ...operands.map((value) =>
      spec.dashIsFile && value === '-' ? './-' : value,
    ),
  ]
  const indirect = options.some(({ flag }) =>
    spec.indirectOptions?.includes(flag),
  )
  const writesOption = options.some(({ flag }) =>
    spec.outputOptions?.includes(flag),
  )
  const writesOperand =
    program === 'uniq' && operands.length > 1 && operands[1] !== '-'

  return {
    values: values.filter((value) => value !== '-'),
    complete: complete && !indirect,
    readOnly: complete && !indirect && !writesOption && !writesOperand,
  }
}
