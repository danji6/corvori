import {
  buildShellCommandLine,
  joinWindowsCommandLine,
} from '@anthropic-ai/sandbox-runtime/dist/sandbox/mxc-sandbox-utils.js'
import type { ContainerRequest } from '@microsoft/mxc-sdk/v1'
import { realpath, writeFile } from 'node:fs/promises'
import { basename, dirname, join, parse, resolve } from 'node:path'

import { isOutside } from '../../mcp/workspace/access'
import type { PreparedShell } from '../launch'
import { shellInvocation } from '../system-shell'
import { windowsTerminal } from './windows-terminal'
import { mountedDrives } from './windows-volumes'

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
  exceptions: string[]
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

/** A narrower read-only rule must not reopen a hidden subtree. */
function readable(path: string, input: WindowsLaunch) {
  return input.hidden.every((deny) => {
    if (isOutside(deny, path)) return true
    return input.exceptions.some(
      (root) =>
        root !== deny && !isOutside(deny, root) && !isOutside(root, path),
    )
  })
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
  const drives = await mountedDrives()
  const reads = [
    ...drives,
    ...input.roots.map((root) => parse(root).root),
    ...input.readonly,
  ]
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
      ...(!input.writable.includes(input.cwd) && {
        config: { filesystem: { enumeratePaths: [input.cwd] } },
      }),
    },
    filesystem: {
      readonlyPaths: [...new Set(reads)].filter(
        (path) => !input.writable.includes(path) && readable(path, input),
      ),
      readwritePaths: input.writable,
      deniedPaths: input.hidden,
    },
    network: {
      egress: { default: input.online ? 'allow' : 'deny' },
      ingress: {
        default: input.online ? 'allow' : 'deny',
        hostLoopback: input.online ? 'allow' : 'deny',
      },
    },
    environment: input.env,
    inheritDefaultEnvironment: false,
    ui: { disable: false, clipboard: 'none', allowInputInjection: false },
  }
  const { probe } = await import('@microsoft/mxc-sdk/v1')
  const facts = probe(request)
  if (
    facts.error ||
    facts.tier !== 'base-container' ||
    facts.needsDaclAugmentation ||
    !facts.probes.baseContainerSupportsDenyPaths
  )
    throw new Error(
      'Windows BaseContainer cannot enforce this workspace policy. Request the command again for approval.',
    )

  const policy = join(input.temporary, 'policy.json')
  await writeFile(policy, JSON.stringify(request), { flag: 'wx', mode: 0o600 })
  const worker = windowsWorker()
  return {
    file: input.runtime,
    args: [worker, policy],
    terminal: (columns, rows) => windowsTerminal(request, columns, rows),
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
