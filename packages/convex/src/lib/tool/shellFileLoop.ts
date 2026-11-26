import { splitShellFileGlob } from '@cv/core/shell/file-glob'

import { listingPathValues } from './listingPathArgs'
import { type ChainSegment, type ShellToken, tokenizeShell } from './shellParse'

const PLAIN_WORD = /^[a-z0-9_./*+@%=,:-]+$/i
const LITERAL_PATH = /^[a-z0-9_./+@% =,:-]+$/i
const DISPLAY_FORMAT = /^(?:[^%\\]|%[s%]|\\[\\abefnrtv])*$/

/** Identify a shell loop even when its path operands cannot be resolved. */
export function isShellLoopSegment(text: string): boolean {
  return /^(?:for|do|done)(?:\s|$)/.test(text)
}

/** Bind a standalone file loop's quoted references to its explicit inputs. */
export function shellFileLoopPaths(segments: ChainSegment[]): string[] | null {
  const [header, start, ...rest] = segments
  const end = rest.pop()
  if (!header || !start || end?.text !== 'done') return null
  if (segments.some(hasUnsupportedSyntax)) return null

  const values = loopValues(header.text)
  if (!values) return null
  const first = /^do(?:[ \t]+(.+))?$/.exec(start.text)
  if (!first) return null
  const commands = rest.map(({ text }) => text)
  if (first[1]) commands.unshift(first[1])
  if (commands.length === 0) return null

  const paths = new Set<string>()
  for (const command of commands) {
    const inputs = loopBodyPaths(tokenizeShell(command), values)
    if (inputs === null) return null
    for (const input of inputs) paths.add(input)
  }
  return [...paths]
}

function hasUnsupportedSyntax(segment: ChainSegment): boolean {
  return (
    segment.hasSubstitution ||
    segment.hasRedirection ||
    segment.separator === 'operator' ||
    /[^\S \t]/.test(segment.text)
  )
}

function loopValues(header: string) {
  const [keyword, variable, separator, ...items] = tokenizeShell(header)
  if (keyword?.raw !== 'for' || separator?.raw !== 'in') return null
  // Bash uses uppercase variable names for shell settings such as PATH.
  if (!variable || !/^[a-z][a-zA-Z0-9_]*$/.test(variable.raw)) return null
  if (!items.length || !items.every(isLoopValue)) return null
  return { name: variable.value, paths: items.map(({ value }) => value) }
}

function isLoopValue(token: ShellToken): boolean {
  if (literalWord(token) && LITERAL_PATH.test(token.value)) return true
  return token.raw === token.value && !!splitShellFileGlob(token.raw)
}

function literalWord(token: ShellToken): boolean {
  if (PLAIN_WORD.test(token.raw) && !token.raw.includes('*')) return true
  return /^'[^']*'$|^"[^"$\\\x60]*"$/.test(token.raw)
}

type LoopValues = NonNullable<ReturnType<typeof loopValues>>

function loopBodyPaths(
  tokens: ShellToken[],
  loop: LoopValues,
): string[] | null {
  const [command, ...args] = tokens
  const reference = '$' + loop.name

  const isReference = ({ raw }: ShellToken) =>
    raw === '"' + reference + '"' || raw === '"$' + '{' + loop.name + '}"'

  if (!args.every((token) => literalWord(token) || isReference(token)))
    return null

  if (command?.raw === 'echo') return []
  if (command?.raw === 'printf') {
    const [format] = args
    return format &&
      literalWord(format) &&
      !format.value.startsWith('-') &&
      DISPLAY_FORMAT.test(format.value)
      ? []
      : null
  }

  const words = args.map((token) =>
    isReference(token) ? reference : token.value,
  )

  if (args.some((token) => token.value === reference && !isReference(token)))
    return null
  return readLoopPaths(command?.raw, words, reference, loop.paths)
}

function readLoopPaths(
  program: string | undefined,
  words: string[],
  reference: string,
  values: string[],
): string[] | null {
  const end = words.indexOf('--')
  const before = end === -1 ? words : words.slice(0, end)
  const after = end === -1 ? [] : words.slice(end + 1)
  const operands = readerOperands(program, before)
  if (!operands) return null
  // The reference must be an operand, including when a flag consumes a value.
  const references = before.filter((word) => word === reference)
  // prettier-ignore
  if (operands.filter((word) => word === reference).length !== references.length)
    return null
  if (references.length && values.some((value) => /^[-*]/.test(value)))
    return null

  const paths: string[] = []
  for (const word of [...operands, ...after]) {
    if (word === reference) paths.push(...values)
    else if (LITERAL_PATH.test(word)) paths.push(word)
    else return null
  }
  return paths
}

function readerOperands(program: string | undefined, args: string[]) {
  if (program === 'cat') {
    return args.every((arg) => !arg.startsWith('-')) ? args : null
  }
  if (program !== 'head' && program !== 'tail') return null
  const parsed = listingPathValues(program, args)
  return parsed?.readOnly ? parsed.values : null
}
