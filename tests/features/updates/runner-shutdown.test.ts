import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { shouldSuppressLogLine } from '~/scripts/runner/logs'
import { ProcessManager, bun } from '~/scripts/runner/processes'

let root: string
let manager: ProcessManager

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'corvori-runner-shutdown-'))
  manager = new ProcessManager({
    cwd: root,
    env: process.env,
    filterLogs: true,
    isolateProcessGroups: true,
    logDir: join(root, 'logs'),
    mode: 'dev',
  })
})

afterEach(async () => {
  await manager?.stopAll()
  await rm(root, { force: true, recursive: true })
})

function service(name: string, signal: NodeJS.Signals) {
  return `
    import { appendFileSync } from 'node:fs'
    process.on(${JSON.stringify(signal)}, () => {
      appendFileSync('shutdown-order', ${JSON.stringify(name + '\n')})
      process.exit(0)
    })
    setInterval(() => {}, 1000)
    console.log('ready')
  `
}

test.skipIf(process.platform === 'win32')(
  'stops the frontend process group before draining Convex and the sidecar',
  async () => {
    const frontend = await manager.spawn(
      'vite-dev',
      bun(
        '--no-env-file',
        '-e',
        `process.on('SIGTERM', () => {})
         const worker = Bun.spawn(${JSON.stringify(bun('--no-env-file', '-e', service('frontend worker', 'SIGTERM')))}, { stdout: 'inherit' })
         await worker.exited`,
      ),
    )
    const backend = await manager.spawn(
      'convex-backend',
      bun('--no-env-file', '-e', service('backend', 'SIGINT')),
      { shutdown: { order: 1, signal: 'SIGINT', leaderOnly: true } },
    )
    const sidecar = await manager.spawn(
      'sidecar',
      bun('--no-env-file', '-e', service('sidecar', 'SIGTERM')),
      { shutdown: { order: 2, leaderOnly: true } },
    )
    const children = [frontend, backend, sidecar]
    await Promise.all(children.map((child) => child.waitForLine('ready', 3000)))

    const watching = manager.waitForAnyExit(children)
    const stopping = manager.stopAll()
    expect(manager.stopAll()).toBe(stopping)
    await Promise.all([watching, stopping])

    const order = await readFile(join(root, 'shutdown-order'), 'utf8')
    expect(order.trim().split('\n')).toEqual([
      'frontend worker',
      'backend',
      'sidecar',
    ])
    expect(await Promise.all(children.map((child) => child.exited))).toEqual([
      0, 0, 0,
    ])
  },
)

test.skipIf(process.platform === 'win32')(
  'reports an unexpected exit while a worker still holds the output pipe',
  async () => {
    const worker = bun(
      '--no-env-file',
      '-e',
      `${service('worker', 'SIGTERM')}
       process.send('ready')`,
    )
    const frontend = await manager.spawn(
      'vite-dev',
      bun(
        '--no-env-file',
        '-e',
        `const worker = Bun.spawn(${JSON.stringify(worker)}, {
           stdout: 'inherit',
           ipc: () => process.exit(130),
         })
         await worker.exited`,
      ),
    )
    await expect(manager.waitForAnyExit([frontend])).rejects.toThrow(
      'vite-dev exited with code 130',
    )
    await manager.stopAll()
    expect(await readFile(join(root, 'shutdown-order'), 'utf8')).toBe(
      'worker\n',
    )
  },
)

test.skipIf(process.platform === 'win32')(
  'force stops a server that ignores the graceful shutdown signal',
  async () => {
    const stubborn = await manager.spawn(
      'stubborn-server',
      bun(
        '--no-env-file',
        '-e',
        `process.on('SIGTERM', () => {})
         setInterval(() => {}, 1000)
         console.log('ready')`,
      ),
    )
    await stubborn.waitForLine('ready', 3000)
    await manager.stopAll()
    expect(await stubborn.exited).toBe(137)
  },
  15_000,
)

test('filters only expected Convex drain messages during shutdown', () => {
  const options = {
    filterLogs: true,
    mode: 'dev',
    name: 'convex-backend',
    shuttingDown: true,
  } as const
  const prefix =
    '2026-11-07T15:32:14.856225Z ERROR common::errors: Caught operational error (RUST_BACKTRACE=1 RUST_LOG=info,common::errors=debug for full trace): '
  const retry = "Your request couldn't be completed. Try again later."
  const database = `${prefix}${retry}: Database Shutting Down`
  const longPoll = `${prefix}Shutting down long poll request: ${retry}`

  expect(shouldSuppressLogLine(database, options)).toBe(true)
  expect(shouldSuppressLogLine(longPoll, options)).toBe(true)
  expect(
    shouldSuppressLogLine(database, { ...options, shuttingDown: false }),
  ).toBe(false)
  expect(
    shouldSuppressLogLine(database, { ...options, filterLogs: false }),
  ).toBe(false)
  expect(shouldSuppressLogLine(database, { ...options, name: 'sidecar' })).toBe(
    false,
  )
  expect(
    shouldSuppressLogLine(`${prefix}${retry}: Database write failed`, options),
  ).toBe(false)
  expect(
    shouldSuppressLogLine("thread 'isolate' panicked at runtime", options),
  ).toBe(false)
})
