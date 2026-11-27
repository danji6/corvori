import { spawn } from 'node:child_process'

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

type LaunchInput = {
  command: string | ShellInvocation
  cwd: string
  environment?: ShellEnvironment
  shell?: string
}

type Terminal = 'pty' | { cols: number; rows: number }

/** Prepare every agent-controlled shell or direct argv launch before selecting its transport. */
export function prepareShellLaunch(input: LaunchInput, terminal?: Terminal) {
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

/** Launch a pipe-backed job in its own process group. */
export function spawnShellPipes(
  input: LaunchInput,
  stdin: 'ignore' | 'pipe',
  terminal?: Exclude<Terminal, 'pty'>,
) {
  const { file, args, cwd, env } = prepareShellLaunch(input, terminal)
  return spawn(file, args, {
    cwd,
    env,
    detached: process.platform !== 'win32',
    stdio: [stdin, 'pipe', 'pipe'],
    windowsHide: true,
  })
}
