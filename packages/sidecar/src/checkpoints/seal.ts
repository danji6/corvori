import { isOutside } from '../mcp/workspace/access'
import type { CheckpointScans } from './coordination'
import { changedFiles, publication } from './diff'
import { displayFile } from './group'
import { snapshot } from './snapshot'
import type { CheckpointStorage } from './storage'
import type { CaptureGroup, Checkpoint } from './types'

export async function sealCheckpoint(
  storage: CheckpointStorage,
  scans: CheckpointScans,
  group: CaptureGroup,
  id: string,
) {
  group.pendingCheckpoint = id
  await storage.save('groups', group.id, group)
  const directoryRoots = group.roots.filter(
    (root) => !group.explicit.includes(root),
  )
  const captured = await scans.run('finish', () =>
    snapshot(storage, directoryRoots, [
      ...group.explicit,
      ...Object.keys(group.baseline),
    ]),
  )
  for (const target of captured.unavailable) {
    if (group.baseline[target]) captured.files[target] = group.baseline[target]
  }

  const unavailable = [...(group.unavailable ?? []), ...captured.unavailable]
  const files = changedFiles(group.baseline, captured.files).filter(
    (file) => !unavailable.some((target) => !isOutside(target, file.target)),
  )
  for (const file of files) file.path = displayFile(group, file.target)

  const issues = [...new Set([...group.issues, ...captured.issues])]
  const display = await publication(storage, id, files, issues)

  const checkpoint: Checkpoint = {
    version: 1,
    id,
    sessionId: group.sessionId,
    groupId: group.id,
    roots: group.roots,
    files,
    publication: display,
  }

  await storage.save('checkpoints', id, checkpoint)
  group.baseline = captured.files
  group.unavailable = captured.unavailable
  group.pendingCheckpoint = undefined
  group.issues = issues
  await storage.save('groups', group.id, group)

  return display
}
