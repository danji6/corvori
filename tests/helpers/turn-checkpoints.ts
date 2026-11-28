import { CheckpointManager } from '@cv/sidecar/checkpoints/manager'
import { CheckpointStorage } from '@cv/sidecar/checkpoints/storage'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { createTempDirectory } from '~/tests/helpers/temp-directory'

export async function checkpointFixture(cleanup: string[]) {
  const base = await createTempDirectory('turn-checkpoint-')
  cleanup.push(base)
  const root = path.join(base, 'project')
  await mkdir(root)
  const storage = new CheckpointStorage(path.join(base, 'snapshots'))
  const manager = new CheckpointManager(storage)
  const workspace = {
    workspaceId: 'workspace',
    path: root,
    label: 'Project',
    sources: [{ id: 'primary', path: root, label: 'Project' }],
  }
  const begin = {
    groupId: 'group',
    participantId: 'parent',
    sessionId: 'session',
    workspace,
  }
  const finish = {
    groupId: 'group',
    participantId: 'parent',
    checkpointId: 'turn',
    root: true,
  }
  const restore = {
    checkpointId: 'turn',
    sessionId: 'session',
    operationId: 'undo',
    revision: 0,
    direction: 'revert' as const,
    workspace,
    allowedPaths: [],
  }
  return { base, root, storage, manager, begin, finish, restore }
}
