import {
  SandboxManager,
  type SandboxRuntimeConfig,
  VENDORED_SRT_WIN_EXE,
  WindowsSandboxError,
} from '@anthropic-ai/sandbox-runtime'
import { join } from 'node:path'

import { snapshotGitPaths } from './ignore-snapshot'

function literal(path: string) {
  return { path, literal: true as const }
}

/** Check the Windows stdio requirement of the pinned MXC SDK before starting a process. */
function requireMxcStdio() {
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (major === 24 && minor >= 21) return
  if (major > 26 || (major === 26 && minor >= 8)) return
  throw new WindowsSandboxError(
    'backend_unsupported',
    'MXC requires Node 24.21+ on the 24.x line or Node 26.8+. Use the embedded Node runtime.',
  )
}

/** Prepare the offline native proof policy from the workspace at launch. */
export async function workspaceProbePolicy(
  root: string,
  vendor: string,
): Promise<SandboxRuntimeConfig> {
  const { hidden, readOnly } = await snapshotGitPaths(root)
  const directory = join(vendor, 'linux-' + process.arch)
  return {
    network: { allowedDomains: [], deniedDomains: [] },
    filesystem: {
      allowRead: [literal(root)],
      allowWrite: [literal(root)],
      denyRead: hidden.map(literal),
      denyWrite: [...hidden, ...readOnly].map(literal),
    },
    ...(process.platform === 'linux' && {
      bwrapPath: join(directory, 'bwrap'),
      socatPath: join(directory, 'socat'),
      ripgrep: { command: join(directory, 'rg') },
    }),
  }
}

/** Select an enforceable backend before the caller starts any workspace command. */
export async function initializeBackend(
  policy: SandboxRuntimeConfig,
  mxcOnly = false,
) {
  if (process.platform !== 'win32') {
    await SandboxManager.initialize(policy, undefined, true)
    return process.platform === 'darwin' ? 'seatbelt' : 'bubblewrap'
  }
  try {
    requireMxcStdio()
    await SandboxManager.initialize(
      { ...policy, windows: { backend: 'mxc' } },
      undefined,
      true,
    )
    return 'mxc'
  } catch (error) {
    if (mxcOnly) throw error
    if (
      !(error instanceof WindowsSandboxError) ||
      error.code !== 'backend_unsupported'
    )
      throw error
    await SandboxManager.reset()
  }
  // Provisioning needs a separate, user-initiated administrator action.
  await SandboxManager.initialize(
    {
      ...policy,
      windows: { backend: 'srt-win', srtWin: { path: VENDORED_SRT_WIN_EXE } },
    },
    undefined,
    true,
  )
  return 'srt-win'
}
