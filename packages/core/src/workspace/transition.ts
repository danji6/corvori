import type { FolderWorkspace } from '../types/workspace'

/** A transition token embeds its deadline so both servers enforce the same lease. */
export function transitionActive(
  token: string | undefined,
  now = Date.now(),
): boolean {
  if (!token) return false
  const deadline = Number(token.split(':')[0])
  return Number.isFinite(deadline) && deadline > now
}
export function workspaceKey(workspace?: FolderWorkspace) {
  return workspace
    ? JSON.stringify([
        workspace.workspaceId,
        workspace.revision ?? 0,
        workspace.sources?.map((source) => source.path) ?? [workspace.path],
      ])
    : '[]'
}
