import { isSessionDirOperand } from '@cv/core/shell/session-dir'

import { parseRunnerInvocation } from './runnerInvocation'
import { DEFAULT_SAFE_SHELL_PATTERNS } from './shellConfig'
import { type ChainSegment, type ShellToken, tokenizeShell } from './shellParse'

const SESSION_DIR_WORD = /^"\$(?:SESSION_DIR|\{SESSION_DIR\})(?:\/(.*))?"$/u
const STATIC_WORD = /^(?:[\w./:=+,%-]+|'[^']*'|"[^"\\$`]*")$/u
const SHELL_CONTROL = new Set(['cd', 'for', 'do', 'done', 'printf'])

function sessionDirOperand(token: ShellToken): string | undefined {
  const match = SESSION_DIR_WORD.exec(token.raw)
  if (!match) return
  const suffix = match[1] || '.'
  if (isSessionDirOperand(suffix)) return suffix
}

/** Recognize the binding only in simple chains with no shell state changes. */
export function hasStaticSessionDirBinding(segments: ChainSegment[]): boolean {
  return segments.every((segment) => {
    if (segment.hasSubstitution || segment.hasRedirection) return false
    const [program, ...args] = tokenizeShell(segment.text)
    if (!program || !/^[\w-]+$/u.test(program.raw)) return false
    if (SHELL_CONTROL.has(program.value)) return false

    const known =
      DEFAULT_SAFE_SHELL_PATTERNS.has(program.value) ||
      DEFAULT_SAFE_SHELL_PATTERNS.has(`${program.value} ${args[0]?.value}`) ||
      parseRunnerInvocation(program.value, args)

    return (
      Boolean(known) &&
      args.every((arg) => STATIC_WORD.test(arg.raw) || sessionDirOperand(arg))
    )
  })
}

/** Preserve quote provenance while the existing argument parsers classify paths. */
export function markSessionDirOperands(
  tokens: ShellToken[],
  operands: Map<string, string>,
): ShellToken[] {
  return tokens.map((token) => {
    const suffix = sessionDirOperand(token)
    if (suffix === undefined) return token
    // NUL cannot occur in an input command analyzed for a session binding.
    const value = `\0/session/${operands.size}`
    operands.set(value, suffix)
    return { ...token, value }
  })
}
