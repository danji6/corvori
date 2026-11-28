import { spawn } from 'node:child_process'
import { basename } from 'node:path'

import {
  type ShellInvocation,
  jobEnv,
  shellInvocation,
  shellPath,
} from './system-shell'

export type ShellEnvironment = {
  AGENT_DIR?: string
  WORKSPACE_DIR?: string
  SESSION_DIR?: string
}

export type PreparedShell = ShellInvocation & {
  /** A native executor that attaches directly to the existing PTY. */
  terminal?: ShellInvocation
  env: NodeJS.ProcessEnv
  cwd?: string
}

type LaunchInput = {
  prepared?: PreparedShell
  command: string | ShellInvocation
  cwd: string
  environment?: ShellEnvironment
  shell?: string
}

type Terminal = 'pty' | { cols: number; rows: number }

export function shellWord(word: string) {
  return "'" + word.replaceAll("'", "'\\''") + "'"
}

/** Prepare every agent-controlled shell or direct argv launch before selecting its transport. */
export function prepareShellLaunch(input: LaunchInput, terminal?: Terminal) {
  if (input.prepared) {
    const { env } = input.prepared
    const { file, args } =
      (terminal === 'pty' && input.prepared.terminal) || input.prepared
    if (!terminal || terminal === 'pty')
      return { file, args, env, cwd: input.prepared.cwd ?? input.cwd }
    // util-linux script takes a shell string. Quote each word of the already prepared native invocation.
    const words = [file, ...args].map(shellWord)
    const sized = `stty cols ${terminal.cols} rows ${terminal.rows} 2>/dev/null; exec ${words.join(' ')}`
    return {
      file: '/usr/bin/script',
      args: ['-qefc', sized, '/dev/null'],
      env: { ...env, SHELL: '/bin/sh' },
      cwd: input.cwd,
    }
  }
  const { command, cwd, environment, shell } = input
  const extra: Record<string, string> = terminal
    ? { TERM: 'xterm-256color' }
    : {}
  let invocation: ShellInvocation
  if (typeof command !== 'string') {
    invocation = command
  } else if (terminal && terminal !== 'pty') {
    extra.SHELL = shellPath(shell)
    const sized = `stty cols ${terminal.cols} rows ${terminal.rows} 2>/dev/null; ${command}`
    invocation = { file: 'script', args: ['-qefc', sized, '/dev/null'] }
  } else {
    invocation = shellInvocation(command, shell)
  }

  return { ...invocation, cwd, env: jobEnv(extra, environment) }
}

/** cmd /s /c strips one outer quote pair and parses the payload verbatim. */
export function cmdArguments(file: string, args: string[]) {
  if (
    process.platform !== 'win32' ||
    basename(file).toLowerCase() !== 'cmd.exe' ||
    args.at(-2) !== '/c'
  )
    return
  return [...args.slice(0, -1), '"' + args.at(-1) + '"']
}

/** Launch a pipe-backed job in its own process group. */
export function spawnShellPipes(
  input: LaunchInput,
  stdin: 'ignore' | 'pipe',
  terminal?: Exclude<Terminal, 'pty'>,
) {
  const { file, args, cwd, env } = prepareShellLaunch(input, terminal)
  const verbatim = cmdArguments(file, args)
  return spawn(file, verbatim ?? args, {
    windowsVerbatimArguments: !!verbatim,
    cwd,
    env,
    detached: process.platform !== 'win32',
    stdio: [stdin, 'pipe', 'pipe'],
    windowsHide: true,
  })
}
