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
