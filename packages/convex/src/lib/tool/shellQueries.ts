import type { ShellToken } from './shellParse'

type ShellQuery = {
  parts: string[]
  paths: string[]
}

const FILE_TESTS = new Set([
  '-b',
  '-c',
  '-d',
  '-e',
  '-f',
  '-g',
  '-h',
  '-k',
  '-L',
  '-N',
  '-O',
  '-G',
  '-p',
  '-r',
  '-s',
  '-S',
  '-u',
  '-w',
  '-x',
])
const NUMERIC_TEST_OPERATORS = new Set([
  '-eq',
  '-ne',
  '-lt',
  '-le',
  '-gt',
  '-ge',
])
const NUMERIC_TEST_OPERAND = /^(?:[+-]?\d+|\$\?)$/

/** Classify builtin lookups and simple tests before wrapper parsing. */
export function readOnlyShellQuery(tokens: ShellToken[]): ShellQuery | null {
  const words = tokens.map((token) => token.value)
  if (words[0] === 'command') return commandLookup(words)
  return testQuery(words)
}

function commandLookup(words: string[]): ShellQuery | null {
  const [, option, ...args] = words
  if (option !== '-v' && option !== '-V') return null
  const names = args[0] === '--' ? args.slice(1) : args
  const paths: string[] = []
  for (const name of names) {
    if (/^\w[\w.+-]*$/.test(name)) continue
    if (!name.includes('/') || !/^[./\w][./\w+-]*$/.test(name)) return null
    paths.push(name)
  }
  return names.length ? { parts: ['command', option], paths } : null
}

function testQuery(words: string[]): ShellQuery | null {
  const [program, ...args] = words
  if (program !== 'test' && program !== '[') return null
  if (program === '[' && args.pop() !== ']') return null
  if (isNumericTest(args)) return { parts: [program], paths: [] }

  const [option, path] = args
  if (args.length !== 2 || !option || !FILE_TESTS.has(option) || !path)
    return null
  return { parts: [program, option], paths: [path === '-' ? './-' : path] }
}

function isNumericTest(args: string[]): boolean {
  if (args.length !== 3) return false
  const [left, operator, right] = args
  return (
    NUMERIC_TEST_OPERATORS.has(operator!) &&
    NUMERIC_TEST_OPERAND.test(left!) &&
    NUMERIC_TEST_OPERAND.test(right!)
  )
}

/** Scope a formatter grant to an installed executable checking explicit paths. */
export function prettierCheckPattern(tokens: ShellToken[]): string[] | null {
  const prefix = ['bun', 'x', '--no-install', 'prettier', '--check']
  if (!prefix.every((word, index) => tokens[index]?.value === word)) return null

  const paths = tokens.slice(prefix.length)
  // A fixed first character keeps glob and brace operands from becoming flags.
  const pathsOnly = paths.every(({ value }) =>
    /^[./\w][./\w,*?{}-]*$/.test(value),
  )
  return paths.length && pathsOnly ? prefix : null
}
