import type { LinuxSandboxParams } from '@anthropic-ai/sandbox-runtime/dist/sandbox/linux-sandbox-utils.js'
import { constants, existsSync } from 'node:fs'
import { access, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

import type { PreparedShell } from '../launch'

const macSystemPaths = [
  '/bin',
  '/usr/bin',
  '/usr/lib',
  '/usr/libexec',
  '/System/Library',
  '/private/etc/ssl/openssl.cnf',
  '/private/etc/ssl/cert.pem',
  '/private/etc/hosts',
  '/private/var/select/sh',
  '/private/etc/resolv.conf',
  '/dev/null',
  '/dev/urandom',
  '/dev/random',
  '/dev/tty',
]

export function linuxPaths() {
  const root = process.cwd()
  const bundled = join(root, 'packages/sidecar/vendor/linux-' + process.arch)
  const sdk = dirname(
    createRequire(import.meta.url).resolve(
      '@anthropic-ai/sandbox-runtime/package.json',
    ),
  )
  return {
    bwrap: join(bundled, 'bwrap'),
    ripgrep: join(bundled, 'rg'),
    seccomp: join(sdk, 'vendor/seccomp', process.arch, 'apply-seccomp'),
    worker: resolve(
      root,
      process.env.CHAT_DATA_DIR || '.data',
      'build/sidecar/linux-preview.js',
    ),
  }
}

/** Check the launch dependencies before running the packaged isolation probe. */
export function previewAvailable() {
  const override = process.env.CORVORI_SHELL_SANDBOX_PREVIEW
  if (override === '0' || (process.versions.bun && override !== '1'))
    return false
  if (process.platform === 'darwin') return existsSync('/usr/bin/sandbox-exec')
  return (
    process.platform === 'linux' &&
    Object.values(linuxPaths()).every((path) => existsSync(path))
  )
}

export function runtimeReadPaths(runtime: string) {
  if (process.platform === 'darwin') return [...macSystemPaths, runtime]
  return [
    '/usr/bin',
    '/usr/lib',
    '/usr/lib64',
    '/lib',
    '/lib64',
    '/bin',
    '/etc/ld.so.cache',
    '/etc/hosts',
    '/etc/resolv.conf',
    '/etc/ssl/certs',
    linuxPaths().seccomp,
    runtime,
  ]
}

export async function wrapPreview(
  policy: LinuxSandboxParams,
  temporary: string,
  runtime: string,
  env: NodeJS.ProcessEnv,
): Promise<PreparedShell> {
  if (process.platform === 'darwin') {
    const { wrapCommandWithSandboxMacOS } =
      await import('@anthropic-ai/sandbox-runtime/dist/sandbox/macos-sandbox-utils.js')
    const command = wrapCommandWithSandboxMacOS({
      ...policy,
      readConfig: policy.readConfig,
      writeConfig: policy.writeConfig,
      allowPty: true,
    })
    return { file: '/bin/sh', args: ['-c', command], env }
  }
  const linux = linuxPaths()
  await Promise.all(
    [linux.bwrap, linux.seccomp, linux.ripgrep].map((path) =>
      access(path, constants.X_OK),
    ),
  )
  const file = join(temporary, 'policy.json')
  await writeFile(
    file,
    JSON.stringify({
      ...policy,
      bwrapPath: linux.bwrap,
      ripgrepConfig: { command: linux.ripgrep },
      seccompConfig: { applyPath: linux.seccomp },
    }),
    { mode: 0o600 },
  )
  return { file: runtime, args: [linux.worker, file], env }
}
