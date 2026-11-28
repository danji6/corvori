import { chmodSync, existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  dataDir,
  defaultNodeBinary,
  projectRoot,
  sidecarDataDir,
} from './runner/config'

const OUT_DIR = resolve(dataDir, 'build/sidecar')
const SIDECAR_ENTRY = resolve(projectRoot, 'packages/sidecar/src/main.ts')

export function sidecarBuildEntry(root: string = dataDir): string {
  return join(root, 'build/sidecar/main.js')
}

/** Restore the executable bit missing from node-pty's packaged macOS helper. */
function prepareMacPtyHelper() {
  if (process.platform !== 'darwin') return
  const helper = join(
    projectRoot,
    'node_modules/node-pty/prebuilds',
    'darwin-' + process.arch,
    'spawn-helper',
  )
  if (!existsSync(helper)) return
  const mode = statSync(helper).mode
  if (mode & 0o100) return
  try {
    chmodSync(helper, mode | 0o100)
  } catch (error) {
    console.warn(
      'Could not enable the macOS PTY helper. Shell commands may use pipes.',
      error,
    )
  }
}

/** Bundles the sidecar to plain JS so it can run under Node. */
export async function buildSidecar(
  windowsQualificationDir?: string,
): Promise<string> {
  prepareMacPtyHelper()
  const result = await Bun.build({
    define: {
      CORVORI_WINDOWS_QUALIFICATION: String(!!windowsQualificationDir),
    },
    entrypoints: [
      SIDECAR_ENTRY,
      resolve(
        projectRoot,
        'packages/sidecar/src/shell/sandbox/sandbox-check.ts',
      ),
      resolve(
        projectRoot,
        'packages/sidecar/src/shell/sandbox/linux-preview.ts',
      ),
      resolve(projectRoot, 'packages/sidecar/src/eval/worker.ts'),
      resolve(
        projectRoot,
        'packages/sidecar/src/shell/sandbox/windows-preview.ts',
      ),
      resolve(projectRoot, 'packages/sidecar/src/mcp/external/stdio-supervisor.ts'), // prettier-ignore
    ],
    naming: '[name].[ext]',
    external: [
      '@hono/node-server',
      '@anthropic-ai/sandbox-runtime',
      '@anthropic-ai/sandbox-runtime/*',
      '@modelcontextprotocol/sdk',
      '@microsoft/mxc-sdk/v1',
      '@mozilla/readability',
      'hono',
      'linkedom',
      'node-pty',
      'png-chunks-encode',
      'png-chunks-extract',
      'sharp',
      'tinyglobby',
      'turndown',
      'zod',
      'quickjs-emscripten',
    ],
    format: 'esm',
    outdir: windowsQualificationDir
      ? join(windowsQualificationDir, 'build/sidecar')
      : OUT_DIR,
    sourcemap: 'linked',
    target: 'node',
  })
  if (!result.success) {
    throw new AggregateError(result.logs, 'Sidecar build failed')
  }
  return sidecarBuildEntry(windowsQualificationDir)
}

/** The embedded Node downloaded by the runner, or the system one. */
export function resolveNodeBinary(): string {
  if (process.env.NODE_BINARY) return process.env.NODE_BINARY
  const embedded = defaultNodeBinary(resolve(projectRoot, 'bin'))
  return existsSync(embedded) ? embedded : 'node'
}

async function runSidecar() {
  if (!process.env.SIDECAR_SECRET?.trim()) {
    throw new Error(
      'SIDECAR_SECRET must match the backend; run ./start.sh or ./dev.sh to provision it automatically',
    )
  }
  const entry = await buildSidecar()
  const child = Bun.spawn({
    cmd: [resolveNodeBinary(), entry],
    cwd: projectRoot,
    env: { ...process.env, CHAT_SIDECAR_DATA_DIR: sidecarDataDir },
    stderr: 'inherit',
    stdin: 'ignore',
    stdout: 'inherit',
  })

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => child.kill(signal))
  }
  process.exit(await child.exited)
}

if (import.meta.main) {
  if (process.argv.includes('--check-sandbox')) {
    await buildSidecar()
    const vendor = join(projectRoot, 'packages/sidecar/vendor')
    const child = Bun.spawn(
      [resolveNodeBinary(), join(OUT_DIR, 'sandbox-check.js'), vendor],
      {
        stdin: 'ignore',
        stdout: 'inherit',
        stderr: 'inherit',
      },
    )
    process.exit(await child.exited)
  } else if (process.argv.includes('--build-only')) {
    await buildSidecar()
  } else {
    await runSidecar()
  }
}
