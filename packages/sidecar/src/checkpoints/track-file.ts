import type { FolderWorkspace } from '@cv/core/types/workspace'
import { assertPersonalScope } from '@cv/core/workspace/personal'

import { isOutside } from '../mcp/workspace/access'
import { sessionDirectory } from '../session-files/storage'
import { captureFile } from './snapshot'
import type { CheckpointStorage } from './storage'
import type { CaptureGroup } from './types'

/** Captures an explicit target before its first write, including ignored files. */
export async function trackFile(
  storage: CheckpointStorage,
  roots: string[],
  group: CaptureGroup | undefined,
  target: string,
  workspace?: FolderWorkspace,
) {
  if (!isOutside(storage.root, target))
    throw new Error('Cannot edit the checkpoint store')

  if (roots.every((root) => isOutside(root, target)))
    throw new Error('File is outside the checkpoint write scope')
  if (!group || group.explicit.includes(target)) return

  assertPersonalScope(workspace, target)

  if (!group.roots.some((root) => !isOutside(root, target)))
    group.roots.push(target)
  const previouslyExcluded = group.excluded.some(
    (entry) => !isOutside(entry, target),
  )

  const previouslyCovered = group.participants.some((participant) => {
    const roots =
      participant.workspace.sources?.map((source) => source.path) ?? []
    if (participant.workspace.sessionFiles)
      roots.push(sessionDirectory(participant.sessionId))
    if (participant.workspace.agentHome)
      roots.push(participant.workspace.agentHome.path)
    return roots.some((root) => !isOutside(root, target))
  })

  if (!previouslyCovered || previouslyExcluded) {
    try {
      const state = await captureFile(storage, target)
      if (!group.baseline[target] && state) group.baseline[target] = state
    } catch (error) {
      group.issues.push(`${target}: ${String(error)}`)
      group.unavailable = [...(group.unavailable ?? []), target]
    }
  }

  group.explicit.push(target)
  try {
    await storage.save('groups', group.id, group)
  } catch (error) {
    group.interrupted = true
    throw error
  }
}
