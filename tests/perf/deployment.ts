import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { ensureConvexBinaries } from '~/scripts/runner/binaries'
import { getConfig, projectRoot, versions } from '~/scripts/runner/config'

const TIMEOUT_MS = 180_000

function reservePort() {
  return Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response(),
  })
}

async function run(
  command: string[],
  cwd: string,
  env: Record<string, string>,
) {
  const child = Bun.spawn(command, {
    cwd,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (status !== 0)
    throw new Error(`${command[1]} failed (${status})\n${stdout}\n${stderr}`)
  return stdout.trim()
}

type Fixture =
  | 'sidebarFixture'
  | 'sharedSendsFixture'
  | 'toolTurnsFixture'
  | 'activeStreamingFixture'

async function prepareFunctions(dir: string, fixture: Fixture) {
  const functions = 'packages/convex/src'
  await mkdir(join(dir, 'packages', 'convex'), { recursive: true })
  await cp(
    join(projectRoot, 'packages/convex/package.json'),
    join(dir, 'packages/convex/package.json'),
  )
  await symlink(
    join(projectRoot, 'packages/convex/node_modules'),
    join(dir, 'packages/convex/node_modules'),
    'junction',
  )
  await cp(join(projectRoot, functions), join(dir, functions), {
    recursive: true,
  })
  await cp(
    join(import.meta.dir, `${fixture}.ts`),
    join(dir, functions, `${fixture}.ts`),
  )
  if (fixture === 'toolTurnsFixture') {
    await cp(
      join(import.meta.dir, 'toolTurnsAction.ts'),
      join(dir, functions, 'toolTurnsAction.ts'),
    )
  }
  await symlink(
    join(projectRoot, 'packages/core'),
    join(dir, 'packages/core'),
    'junction',
  )
  await symlink(
    join(projectRoot, 'node_modules'),
    join(dir, 'node_modules'),
    'junction',
  )
  await writeFile(
    join(dir, 'package.json'),
    '{"type":"module","dependencies":{"convex":"*"}}\n',
  )
  await writeFile(join(dir, 'convex.json'), JSON.stringify({ functions }))
}

export async function withDeployment<T>(
  execute: (deployment: Deployment) => Promise<T>,
  fixture: Fixture = 'sidebarFixture',
  editFunctions?: (functions: string) => Promise<void>,
) {
  const dir = await mkdtemp(join(tmpdir(), 'corvori-perf-'))
  try {
    const config = getConfig('dev')
    config.dataDir = dir
    config.releaseTag = versions.convexBackend
    config.nodeVersion = versions.node
    await ensureConvexBinaries(config)
    await prepareFunctions(dir, fixture)
    await editFunctions?.(join(dir, 'packages/convex/src'))
    return await runDeployment(dir, config, execute)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function runDeployment<T>(
  dir: string,
  config: ReturnType<typeof getConfig>,
  execute: (deployment: Deployment) => Promise<T>,
) {
  const ports = [reservePort(), reservePort()]
  const [url, site] = ports.map(({ port }) => `http://localhost:${port}`)
  const env = {
    PATH: [dirname(config.nodeBinary), process.env.PATH].join(delimiter),
    ...Object.fromEntries(
      ['SYSTEMROOT', 'TMP', 'TEMP', 'TMPDIR', 'USERPROFILE'].flatMap((key) => {
        const value = process.env[key]
        return value ? [[key, value]] : []
      }),
    ),
    DISABLE_BEACON: 'true',
    CONVEX_TELEMETRY_DISABLED: '1',
  }
  const secret = crypto.randomUUID().replaceAll('-', '').repeat(2)
  const instance = [
    '--instance-name',
    'corvori-perf',
    '--instance-secret',
    secret,
  ]
  const key = await run(
    [config.convexBinary, 'keygen', 'admin-key', ...instance],
    dir,
    env,
  )
  const log = Bun.file(join(dir, 'backend.log'))
  const args = backendArgs(
    instance,
    ports.map(({ port }) => port!),
    url,
    site,
  )
  for (const port of ports) port.stop(true)
  const backend = Bun.spawn([config.convexBinary, ...args], {
    cwd: dir,
    env,
    stdout: log,
    stderr: log,
  })
  try {
    await waitForBackend(url, backend)
    await deployFunctions(dir, url, site, key, env)
    return await execute({ dir, url, site, key, env, backendPid: backend.pid })
  } catch (error) {
    const diagnostic = (await log.text())
      .slice(-8000)
      .replaceAll(secret, '[redacted]')
      .replaceAll(key, '[redacted]')
    console.error(diagnostic)
    throw error
  } finally {
    backend.kill()
    await backend.exited
  }
}

function backendArgs(
  instance: string[],
  ports: number[],
  url: string,
  site: string,
) {
  return [
    ...instance,
    '--interface',
    '127.0.0.1',
    '--port',
    String(ports[0]),
    '--site-proxy-port',
    String(ports[1]),
    '--convex-origin',
    url,
    '--convex-site',
    site,
    '--local-storage',
    'storage',
    'convex.sqlite3',
  ]
}

async function waitForBackend(
  url: string,
  backend: { exitCode: number | null },
) {
  const deadline = performance.now() + 15_000
  while (backend.exitCode === null && performance.now() < deadline) {
    const response = await fetch(`${url}/version`, {
      signal: AbortSignal.timeout(500),
    }).catch(() => null)
    if (response?.ok) return
    await Bun.sleep(50)
  }
  throw new Error('Local Convex backend failed to become ready')
}

async function deployFunctions(
  dir: string,
  url: string,
  site: string,
  key: string,
  env: Record<string, string>,
) {
  const cli = [
    process.execPath,
    '--no-env-file',
    join(projectRoot, 'node_modules/convex/bin/main.js'),
  ]
  const deploymentEnv = {
    ...env,
    CONVEX_SELF_HOSTED_URL: url,
    CONVEX_SELF_HOSTED_ADMIN_KEY: key,
  }
  await run(
    [...cli, 'env', 'set', 'BETTER_AUTH_SECRET', crypto.randomUUID().repeat(2)],
    dir,
    deploymentEnv,
  )
  await run([...cli, 'env', 'set', 'SITE_URL', site], dir, deploymentEnv)
  console.log('Deploying the app and benchmark fixture to local Convex')
  await run(
    [
      ...cli,
      'deploy',
      '--typecheck',
      'disable',
      '--codegen',
      'disable',
      '--yes',
    ],
    dir,
    deploymentEnv,
  )
}

export type Deployment = {
  dir: string
  url: string
  site: string
  key: string
  env: Record<string, string>
  backendPid: number
}

export function buildClient(deployment: Deployment) {
  const code = `import { build } from 'vite';
    await build({ envDir: false, build: { outDir: ${JSON.stringify(join(deployment.dir, 'client'))}, emptyOutDir: true } });`
  return run(
    [process.execPath, '--no-env-file', '-e', code],
    join(projectRoot, 'packages/client'),
    {
      ...deployment.env,
      VITE_CONVEX_URL: deployment.url,
      VITE_CONVEX_SITE_URL: deployment.site,
    },
  )
}

export async function withBrowserClient<T>(
  deployment: Deployment,
  execute: (frontend: string) => Promise<T>,
) {
  console.log('Building production client for the Chromium observer')
  await buildClient(deployment)
  const root = join(deployment.dir, 'client')
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const asset = join(root, new URL(request.url).pathname)
      if (asset.startsWith(root + '/') && (await Bun.file(asset).exists()))
        return new Response(Bun.file(asset))
      return new Response(Bun.file(join(root, 'index.html')))
    },
  })
  try {
    return await execute(`http://localhost:${server.port}`)
  } finally {
    server.stop(true)
  }
}
