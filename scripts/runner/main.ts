import { join } from 'node:path'

import { ensureConvexBinaries } from './binaries'
import { buildFrontendIfNeeded } from './build-cache'
import {
  type RunnerConfig,
  type RunnerOptions,
  browserOrigins,
  defaultEnvFile,
  getConfig,
  parseRunnerOptions,
} from './config'
import {
  deployWithMigrations,
  prepareEnvironment,
  setConvexEnvironment,
  startBackend,
  startConvexDev,
} from './convex'
import { ensureDependencies } from './deps'
import { loadEnvFile } from './env-file'
import { freePorts } from './ports'
import {
  type ManagedProcess,
  ProcessManager,
  finishesWithin,
} from './processes'
import { startSidecar } from './sidecar'
import { applyUpdateIfRequested, rollbackUpdate } from './update'

export async function run(args: string[]) {
  if (args.includes('--help') || args.includes('-h')) {
    printHelp()
    return
  }

  await loadEnvFile(defaultEnvFile)

  const options = parseRunnerOptions(args)
  const config = getConfig(options.mode)
  config.trustAny = options.trustAny
  config.exposeUrl = options.exposeUrl
  process.env.RUST_LOG = config.rustLog

  if (config.trustAny || config.exposeUrl) {
    console.log(
      config.trustAny
        ? 'Exposing auth to ANY origin (insecure).'
        : `Exposing auth to external origin: ${config.exposeUrl}`,
    )
    console.log(
      `Ensure these ports are reachable from the visitor (firewall/NAT): ` +
        `${config.frontendPort} (frontend), ${config.convexPort} (convex), ` +
        `${config.convexSitePort} (http actions).`,
    )
    console.log(
      'Traffic is unencrypted unless using a TLS proxy. See docs/https.md.',
    )
  }

  const manager = new ProcessManager({
    cwd: config.projectRoot,
    env: process.env,
    filterLogs: options.filterLogs,
    isolateProcessGroups: true,
    logDir: config.logDir,
    mode: options.mode,
  })

  const { promise: interrupted, resolve: stop } =
    Promise.withResolvers<number>()
  const onInterrupt = () => stop(130)
  const onTerminate = () => stop(143)
  process.on('SIGINT', onInterrupt)
  process.on('SIGTERM', onTerminate)

  let exitCode: number | void
  try {
    exitCode = await Promise.race([
      interrupted,
      launch(config, manager, options),
    ])
  } catch (error) {
    console.error(error)
    exitCode = 1
  }

  try {
    if (exitCode !== undefined) await shutdown(config, manager, exitCode)
  } finally {
    process.off('SIGINT', onInterrupt)
    process.off('SIGTERM', onTerminate)
  }
  if (exitCode !== undefined) process.exit(exitCode)
}

async function launch(
  config: RunnerConfig,
  manager: ProcessManager,
  options: RunnerOptions,
) {
  if (options.rollback) await rollbackUpdate(config)

  const update = await applyUpdateIfRequested(config, {
    enabled: options.update,
  })
  if (update === 'relaunch') return

  await ensureDependencies(manager, config, { enabled: options.install })
  await ensureConvexBinaries(config)
  await prepareEnvironment(config)
  if (options.mode === 'start') {
    await start(config, manager, options)
  } else {
    await dev(config, manager, options.killPorts)
  }
}

async function shutdown(
  config: RunnerConfig,
  manager: ProcessManager,
  exitCode: number,
) {
  console.log('')
  console.log('Stopping...')
  const hasDashboard = manager.hasProcess('convex-dashboard')
  await Promise.all([
    manager.stopAll(exitCode === 130),
    hasDashboard ? cleanupDocker(config) : undefined,
  ])
}

async function start(
  config: RunnerConfig,
  manager: ProcessManager,
  options: { forceBuild: boolean; killPorts: boolean },
) {
  await freePorts(
    [
      config.convexPort,
      config.convexSitePort,
      config.sidecarPort,
      config.frontendPort,
    ],
    {
      cwd: config.projectRoot,
      enabled: options.killPorts,
    },
  )

  const [sidecar, backend] = await parallel(
    readySidecar(manager, config, 30_000),
    deployToBackend(manager, config, 30_000),
  )

  await buildFrontendIfNeeded(manager, config, { force: options.forceBuild })

  const preview = await startFrontend(config, manager)
  await manager.waitForAnyExit([sidecar, backend, preview])
}

async function dev(
  config: RunnerConfig,
  manager: ProcessManager,
  killPorts: boolean,
) {
  await freePorts(
    [
      config.convexPort,
      config.convexSitePort,
      config.convexDashboardPort,
      config.sidecarPort,
      config.frontendPort,
    ],
    {
      cwd: config.projectRoot,
      enabled: killPorts,
    },
  )

  const [sidecar, backend] = await parallel(
    readySidecar(manager, config, 60_000),
    readyBackend(manager, config, 60_000),
    restartDashboard(manager, config),
  )

  await deployWithMigrations(manager, config)
  const convexDev = await startConvexDev(manager, config)
  const vite = await startFrontend(config, manager)

  await manager.waitForAnyExit([sidecar, backend, convexDev, vite])
}

function startFrontend(config: RunnerConfig, manager: ProcessManager) {
  const preview = config.mode === 'start'
  const args = [
    config.nodeBinary,
    join(config.projectRoot, 'node_modules/vite/bin/vite.js'),
    ...(preview ? ['preview'] : ['--clearScreen', 'false']),
    '--host',
    config.frontendHost,
    '--port',
    String(config.frontendPort),
    '--strictPort',
  ]
  return manager.spawn(preview ? 'vite-preview' : 'vite-dev', args, {
    cwd: config.clientRoot,
    env: { CORVORI_CONVEX_INTERNAL_URL: config.convexInternalUrl },
  })
}

function parallel<T extends readonly Promise<unknown>[]>(...tasks: T) {
  for (const task of tasks) {
    void task.catch(() => {})
  }
  return Promise.all(tasks)
}

async function readySidecar(
  manager: ProcessManager,
  config: RunnerConfig,
  timeoutMs: number,
) {
  const sidecar = await startSidecar(manager, config)
  await waitForService(
    manager,
    sidecar,
    `http://localhost:${config.sidecarPort}/health`,
    timeoutMs,
  )
  console.log('Sidecar server ready.')
  return sidecar
}

async function readyBackend(
  manager: ProcessManager,
  config: RunnerConfig,
  timeoutMs: number,
) {
  const backend = await startBackend(manager, config)
  console.log(`Started Convex backend (pid ${backend.pid})`)
  await waitForService(
    manager,
    backend,
    `${config.convexInternalUrl}/version`,
    timeoutMs,
  )
  console.log('Backend ready.')

  await setConvexEnvironment(config)
  return backend
}

async function deployToBackend(
  manager: ProcessManager,
  config: RunnerConfig,
  timeoutMs: number,
) {
  const backend = await readyBackend(manager, config, timeoutMs)
  await deployWithMigrations(manager, config)
  return backend
}

async function restartDashboard(manager: ProcessManager, config: RunnerConfig) {
  if (!(await runDocker(config, ['info', '--format', '{{.ServerVersion}}']))) {
    console.error('Docker is not running, skipping Convex dashboard.')
    return
  }

  await cleanupDocker(config)
  await startDashboard(manager, config)
}

async function startDashboard(manager: ProcessManager, config: RunnerConfig) {
  const dashboard = await manager.spawn('convex-dashboard', [
    'docker',
    'run',
    '--rm',
    '--name',
    config.convexDashboardContainer,
    '-p',
    `127.0.0.1:${config.convexDashboardPort}:6791`,
    '-e',
    `NEXT_PUBLIC_DEPLOYMENT_URL=${browserOrigins(config).convexUrl}`,
    config.convexDashboardImage,
  ])
  console.log(`Started Convex dashboard (pid ${dashboard.pid})`)

  try {
    await waitForService(
      manager,
      dashboard,
      `http://localhost:${config.convexDashboardPort}`,
      60_000,
    )
    if (manager.stopping) return

    console.log(
      `Convex dashboard ready at http://localhost:${config.convexDashboardPort}.`,
    )
  } catch {
    if (!manager.stopping) {
      console.error('Convex dashboard unavailable; continuing without it.')
    }
  }
}

function cleanupDocker(config: RunnerConfig) {
  return runDocker(config, ['rm', '-f', config.convexDashboardContainer])
}

async function runDocker(config: RunnerConfig, args: string[]) {
  try {
    const child = Bun.spawn({
      cmd: ['docker', ...args],
      cwd: config.projectRoot,
      stderr: 'ignore',
      stdout: 'ignore',
    })
    if (await finishesWithin(child.exited, 5_000)) {
      return (await child.exited) === 0
    }

    child.kill('SIGKILL')
    console.warn(
      `Timed out running docker ${args[0]} for the Convex dashboard.`,
    )
  } catch {
    // Docker may be unavailable.
  }
  return false
}

async function waitForService(
  manager: ProcessManager,
  child: ManagedProcess,
  url: string,
  timeoutMs: number,
) {
  const controller = new AbortController()
  try {
    await Promise.race([
      waitForHttp(url, timeoutMs, true, controller.signal),
      manager.waitForAnyExit([child]),
    ])
  } finally {
    controller.abort()
  }
}

export async function waitForHttp(
  url: string,
  timeoutMs: number,
  requireOk: boolean,
  cancel?: AbortSignal,
) {
  const deadline = AbortSignal.timeout(timeoutMs)
  const signal = cancel ? AbortSignal.any([deadline, cancel]) : deadline
  while (!signal.aborted) {
    try {
      const response = await fetch(url, { signal })
      if (!requireOk || response.ok) return
    } catch {
      // Retry until timeout.
    }
    await sleep(1000)
  }
  throw new Error(`Timed out waiting for ${url}`)
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function printHelp() {
  console.log(`Usage: bun scripts/runner.ts [dev|start] [options]

Modes:
  dev      Start local Convex, dashboard, sidecar, convex dev, and Vite.
  start    Deploy once, build, and run the production preview server.

Options:
  --rebuild           Force a frontend production build in start mode.
  --no-install        Skip the automatic dependency install.
  --no-update         Skip the update check (same as AUTO_UPDATE=false).
  --rollback          Restore the tree and database saved by the last update.
  --expose[=<origin>] Trust an external frontend origin for auth so a remote
                      browser can sign in. With a value, e.g.
                      --expose=http://203.0.113.5:5173, only that origin is
                      trusted. No value trusts any origin (insecure).
  --log-filters=off   Show all child-process log lines in start mode.
  --no-kill-ports     Do not stop existing processes on required ports.
  -h, --help          Show this help.

Updates (releases only):
  AUTO_UPDATE=true        Install a newer release without prompting.
  AUTO_UPDATE=false       Never check for updates.
  UPDATE_FEED_URL         Release feed to check.

Reverse proxy / HTTPS (see docs/https.md), set in .env.local:
  FRONTEND_URL            Public frontend origin, e.g. https://chat.example.com
  CONVEX_SELF_HOSTED_URL  Public backend origin, e.g. https://convex.example.com
  CONVEX_SITE_URL         Public HTTP actions origin
  CONVEX_INTERFACE        Backend bind address (set 127.0.0.1 behind a proxy)
  CONVEX_PORT             Backend port (default 3210)
  CONVEX_SITE_PORT        HTTP actions port (default 3211)
  FRONTEND_HOST           Frontend bind address (default 0.0.0.0)
  NODE_ACTION_USER_TIMEOUT_SECS
                          Backend Node action timeout in seconds
                          (default: 1800; keep above the stream engine's
                          5-minute handoff window)

Logs are written to .data/logs.`)
}
