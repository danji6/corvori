import {
  buildShellCommandLine,
  joinWindowsCommandLine,
} from '@anthropic-ai/sandbox-runtime/dist/sandbox/mxc-sandbox-utils.js'
import type { ContainerRequest } from '@microsoft/mxc-sdk/v1'
import { realpath, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve, win32 } from 'node:path'

import { isOutside } from '../../mcp/workspace/access'
import type { PreparedShell } from '../launch'
import { shellInvocation } from '../system-shell'

export function windowsWorker() {
  return resolve(
    process.cwd(),
    process.env.CHAT_DATA_DIR || '.data',
    'build/sidecar/windows-preview.js',
  )
}

type WindowsLaunch = {
  roots: string[]
  hidden: string[]
  readonly: string[]
  writable: string[]
  cwd: string
  command: string
  shell?: string
  argv?: string[]
  online: boolean
  env: NodeJS.ProcessEnv
  runtime: string
  temporary: string
}

/** Include each mounted drive letter, even when it supplies no workspace grants. */
async function mountedDriveRoots() {
  const roots: string[] = []
  for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    const root = letter + ':\\'
    try {
      await stat(root)
      roots.push(root)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return roots
}

/** Compile a per-command BaseContainer request with explicit filesystem grants. */
export async function windowsRequest(
  input: WindowsLaunch,
): Promise<PreparedShell> {
  const shell = input.argv
    ? undefined
    : shellInvocation(input.command, input.shell)
  const executable = await realpath(shell?.file ?? input.argv![0])
  const name = basename(executable).toLowerCase()
  const reads = [...input.readonly]
  const system = process.env.SystemRoot
  if (!system) throw new Error('Missing Windows system directory')
  for (const directory of ['System32', 'SysWOW64', 'WinSxS']) {
    const path = join(system, directory)
    if (
      await stat(path).then(
        (s) => s.isDirectory(),
        () => false,
      )
    )
      reads.push(path)
  }
  const openssl = join(input.temporary, 'openssl.cnf')
  await writeFile(openssl, '', { flag: 'wx' })
  reads.push(openssl)
  const volumes = await mountedDriveRoots()
  if (
    input.roots.some(
      (root) => !volumes.includes(win32.parse(root).root.toUpperCase()),
    )
  )
    throw new Error('Windows workspace requires a mounted local drive')
  if (shell) {
    if (!['cmd.exe', 'powershell.exe', 'pwsh.exe'].includes(name))
      throw new Error('Unsupported Windows sandbox shell')
    const shellHome = dirname(executable)
    if (
      input.roots.some(
        (root) => !isOutside(root, shellHome) || !isOutside(shellHome, root),
      )
    )
      throw new Error('The Windows shell installation overlaps the workspace')
    reads.push(shellHome)
  }
  const command =
    shell && name === 'cmd.exe'
      ? buildShellCommandLine(
          { exe: executable, args: shell.args.slice(0, -1) },
          input.command,
        )
      : joinWindowsCommandLine([
          executable,
          ...(shell?.args ?? input.argv!.slice(1)),
        ])
  const request: ContainerRequest = {
    command,
    workingDirectory: input.cwd,
    containment: {
      type: 'processcontainer',
      config: {
        filesystem: { enumeratePaths: [...volumes, dirname(input.runtime)] },
      },
    },
    filesystem: {
      readonlyPaths: [...new Set(reads)].filter(
        (p) =>
          !input.writable.includes(p) &&
          input.hidden.every((h) => isOutside(h, p)),
      ),
      readwritePaths: input.writable,
      deniedPaths: [...input.hidden, ...volumes],
    },
    network: {
      egress: { default: input.online ? 'allow' : 'deny' },
      ingress: {
        default: input.online ? 'allow' : 'deny',
        hostLoopback: input.online ? 'allow' : 'deny',
      },
    },
    environment: {
      ...input.env,
      OPENSSL_CONF: openssl,
      NODE_OPTIONS: '--preserve-symlinks-main --preserve-symlinks',
    },
    inheritDefaultEnvironment: false,
    ui: { disable: false, clipboard: 'none', allowInputInjection: false },
  }
  const policy = join(input.temporary, 'policy.json')
  await writeFile(policy, JSON.stringify(request), { flag: 'wx', mode: 0o600 })
  const worker = windowsWorker()
  return {
    file: input.runtime,
    args: [worker, policy],
    cwd: dirname(worker),
    env: {
      SystemRoot: process.env.SystemRoot,
      LOCALAPPDATA: process.env.LOCALAPPDATA,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      PATH: dirname(input.runtime),
    },
  }
}
