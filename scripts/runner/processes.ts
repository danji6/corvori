import { type ChildProcess, spawn } from 'node:child_process'
import { constants } from 'node:os'
import type { Readable } from 'node:stream'

import type { RunnerMode } from './config'
import { type LogSink, createLogSink } from './logs'

export type ManagedProcess = {
  exit: Promise<number>
  exited: Promise<number>
  kill(signal?: NodeJS.Signals): void
  name: string
  pid: number | undefined
  waitForLine(text: string, timeoutMs: number): Promise<void>
}

type ShutdownOptions = {
  order?: number
  signal?: NodeJS.Signals
  leaderOnly?: boolean
}

type SpawnOptions = {
  cwd?: string
  env?: NodeJS.ProcessEnv
  shutdown?: ShutdownOptions
}

export class ProcessManager {
  private readonly processes = new Map<ManagedProcess, ShutdownOptions>()
  private shutdown?: Promise<void>

  constructor(
    private readonly options: {
      cwd: string
      env: NodeJS.ProcessEnv
      filterLogs: boolean
      logDir: string
      mode: RunnerMode
      isolateProcessGroups?: boolean
    },
  ) {}

  async spawn(name: string, cmd: string[], options: SpawnOptions = {}) {
    const sink = await createLogSink({
      filterLogs: this.options.filterLogs,
      logDir: this.options.logDir,
      mode: this.options.mode,
      name,
    })
    if (this.shutdown) {
      await sink.close()
      throw new Error('The launcher is stopping')
    }

    const shutdown = options.shutdown ?? {}
    const env = withColorEnvironment({ ...this.options.env, ...options.env })
    const detached =
      Boolean(this.options.isolateProcessGroups) && process.platform !== 'win32'
    const child = spawn(cmd[0]!, cmd.slice(1), {
      cwd: options.cwd ?? this.options.cwd,
      detached,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const exit = waitForExit(child)

    const outputDone = Promise.allSettled([
      routeOutput(child.stdout, process.stdout, sink, 'stdout'),
      routeOutput(child.stderr, process.stderr, sink, 'stderr'),
    ])

    const managed: ManagedProcess = {
      exit,
      exited: exit.finally(async () => {
        await outputDone
        await sink.close().finally(() => this.processes.delete(managed))
      }),
      kill(signal = shutdown.signal ?? 'SIGTERM') {
        sink.startShutdown()
        const signalGroup =
          detached && (!shutdown.leaderOnly || signal === 'SIGKILL')
        signalChild(child, signal, signalGroup)
      },
      name,
      pid: child.pid,
      waitForLine(text, timeoutMs) {
        return waitForLine(sink, managed, text, timeoutMs)
      },
    }
    void managed.exited.catch(() => {})
    this.processes.set(managed, shutdown)
    return managed
  }

  async run(
    name: string,
    cmd: string[],
    options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
  ) {
    const process = await this.spawn(name, cmd, options)
    const exitCode = await process.exit
    if (exitCode !== 0) {
      throw new Error(`${name} exited with code ${exitCode}`)
    }
    await process.exited
  }

  hasProcess(name: string) {
    return [...this.processes.keys()].some((child) => child.name === name)
  }

  get stopping() {
    return this.shutdown !== undefined
  }

  stopAll(consoleInterrupted = false) {
    this.shutdown ??= this.stopInOrder(consoleInterrupted)
    return this.shutdown
  }

  private async stopInOrder(consoleInterrupted: boolean) {
    const children = [...this.processes]
    const orders = new Set(children.map(([, options]) => options.order ?? 0))
    for (const order of [...orders].sort((a, b) => a - b)) {
      const group = children.filter(
        ([, options]) => (options.order ?? 0) === order,
      )
      const results = await Promise.allSettled(
        group.map(([child]) => stopProcess(child, consoleInterrupted)),
      )
      for (const result of results) {
        if (result.status === 'rejected') console.warn(result.reason)
      }
    }
  }

  async waitForAnyExit(processes: ManagedProcess[]) {
    await Promise.race(
      processes.map(async (child) => {
        const code = await child.exit
        if (!this.shutdown)
          throw new Error(`${child.name} exited with code ${code}`)
      }),
    )
  }
}

function waitForExit(child: ChildProcess) {
  return new Promise<number>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      resolve(code ?? 128 + (signal ? constants.signals[signal] : 0))
    })
  })
}

function signalChild(
  child: ChildProcess,
  signal: NodeJS.Signals,
  signalGroup: boolean,
) {
  if (!child.pid) return
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    killer.on('error', () => child.kill())
    killer.on('exit', (code) => {
      if (code !== 0 && child.exitCode === null && child.signalCode === null) {
        child.kill()
      }
    })
    killer.unref()
    return
  }

  if (signalGroup) {
    try {
      process.kill(-child.pid, signal)
    } catch (error) {
      const groupExited =
        error instanceof Error && 'code' in error && error.code === 'ESRCH'
      if (!groupExited) throw error
    }
  } else {
    child.kill(signal)
  }
}

async function stopProcess(child: ManagedProcess, consoleInterrupted: boolean) {
  // Windows sends console Ctrl+C directly to the attached children.
  if (!(consoleInterrupted && process.platform === 'win32')) child.kill()
  if (await finishesWithin(child.exited, 10_000)) return

  console.warn(`${child.name} did not stop within 10 seconds. Force stopping.`)
  child.kill('SIGKILL')
  if (!(await finishesWithin(child.exited, 1_000))) {
    console.warn(
      `Timed out waiting for ${child.name} to exit and close its logs.`,
    )
  }
}

export async function finishesWithin(
  task: Promise<unknown>,
  timeoutMs: number,
) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs)
  })
  try {
    return await Promise.race([
      task.then(
        () => true,
        () => true,
      ),
      timeout,
    ])
  } finally {
    clearTimeout(timer)
  }
}

export function supportsColor(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(process.stdout.isTTY) && !env.NO_COLOR
}

export function green(text: string): string {
  return supportsColor() ? `\x1b[32m${text}\x1b[0m` : text
}

function withColorEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!supportsColor(env)) return env

  return {
    ...env,
    CLICOLOR: env.CLICOLOR ?? '1',
    CLICOLOR_FORCE: env.CLICOLOR_FORCE ?? '1',
    COLORTERM: env.COLORTERM ?? 'truecolor',
    FORCE_COLOR: env.FORCE_COLOR ?? '1',
    TERM: env.TERM ?? 'xterm-256color',
  }
}

/** The Bun the bootstrap picked. Use this instead of calling Bun directly. */
export function bun(...args: string[]): string[] {
  return [process.execPath, ...args]
}

export function bunx(...args: string[]): string[] {
  return [process.execPath, 'x', ...args]
}

export async function commandResult(
  cmd: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
) {
  const child = Bun.spawn({
    cmd,
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    stderr: 'pipe',
    stdout: 'pipe',
  })
  const stdout = await new Response(child.stdout).text()
  const stderr = await new Response(child.stderr).text()
  const exitCode = await child.exited
  return { exitCode, stderr, stdout }
}

export async function output(
  cmd: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
) {
  const { exitCode, stderr, stdout } = await commandResult(cmd, options)
  if (exitCode !== 0) {
    throw new Error(`${cmd.join(' ')} failed: ${stderr.trim()}`)
  }
  return stdout.trim()
}

async function routeOutput(
  stream: Readable | null,
  target: NodeJS.WriteStream,
  sink: LogSink,
  channel: 'stderr' | 'stdout',
) {
  if (!stream) return

  for await (const chunk of stream) {
    sink.handleChunk(chunk, target, channel)
  }
}

async function waitForLine(
  sink: LogSink,
  child: ManagedProcess,
  text: string,
  timeoutMs: number,
) {
  const { promise, resolve } = Promise.withResolvers<void>()
  const unsubscribe = sink.onLine((line) => {
    if (line.includes(text)) resolve()
  })
  try {
    const result = await Promise.race([
      finishesWithin(promise, timeoutMs).then((matched) => ({ matched })),
      child.exit.then((code) => ({ code })),
    ])
    if ('code' in result)
      throw new Error(`${child.name} exited with code ${result.code}`)
    if (!result.matched)
      throw new Error(`Timed out waiting for log line: ${text}`)
  } finally {
    unsubscribe()
    resolve()
  }
}
