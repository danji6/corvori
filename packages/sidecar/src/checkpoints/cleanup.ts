import { collectBlobs } from './group'
import { hasCaptureJobs } from './jobs'
import type { CheckpointStorage } from './storage'
import type { CaptureGroup, Checkpoint } from './types'

/** Removes a session's records while capture and restore operations are idle. */
export async function removeSessionCheckpoints(
  storage: CheckpointStorage,
  groups: Map<string, CaptureGroup>,
  sessionId: string,
) {
  const owned = [...groups.values()].filter(
    (group) => group.sessionId === sessionId,
  )
  const running = await Promise.all(owned.map(hasCaptureJobs))
  if (running.some(Boolean))
    throw new Error('Waiting for background jobs to stop')

  for (const group of owned) {
    await storage.remove('groups', group.id)
    groups.delete(group.id)
  }

  for (const group of await storage.records<CaptureGroup>('groups')) {
    if (group.sessionId === sessionId) await storage.remove('groups', group.id)
  }
  for (const checkpoint of await storage.records<Checkpoint>('checkpoints')) {
    if (checkpoint.sessionId === sessionId)
      await storage.remove('checkpoints', checkpoint.id)
  }
  await collectBlobs(storage, groups.values())
}
