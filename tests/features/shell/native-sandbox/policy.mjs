import { VENDORED_SRT_WIN_EXE } from '@anthropic-ai/sandbox-runtime'
import process from 'node:process'

/** Build the candidate policy for a disposable fixture on this host. */
export function offlinePolicy(workspace, protectedFiles = []) {
  return {
    network: { allowedDomains: [], deniedDomains: [] },
    filesystem: {
      allowWrite: [workspace],
      allowRead: [workspace],
      denyRead: protectedFiles,
      denyWrite: protectedFiles,
    },
    ...(process.platform === 'win32' && {
      windows: { srtWin: { path: VENDORED_SRT_WIN_EXE } },
    }),
  }
}
