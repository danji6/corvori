import type { FolderWorkspace } from '@cv/core/types/workspace'
import { selectFileWorkspace } from '@cv/core/workspace/personal'
import path from 'node:path'

import { isOutside } from '../mcp/workspace/access'
import { requireWorkspace } from '../mcp/workspace/resolve-workspace'
import {
  ensureSessionDirectory,
  sessionDirectory,
} from '../session-files/storage'
import type { CheckpointStorage } from './storage'
import type {
  BeginCapture,
  CaptureGroup,
  Checkpoint,
  RestoreJournal,
  Snapshot,
} from './types'

export const overlaps = (left: string[], right: string[]) =>
  left.some((a) => right.some((b) => !isOutside(a, b) || !isOutside(b, a)))

export async function workspaceRoots(
  sessionId: string,
  context: FolderWorkspace,
) {
  const selected = context.agentOnly
    ? selectFileWorkspace(context, 'agent://')
    : context
  const workspace = await requireWorkspace(
    sessionId,
    selected.workspaceId,
    selected,
  )

  if (context.agentHome && !context.agentOnly) {
    const personal = selectFileWorkspace(context, 'agent://')
    const home = await requireWorkspace(
      sessionId,
      personal.workspaceId,
      personal,
    )
    workspace.roots.push(...home.roots)
  }
  if (context.sessionFiles) {
    workspace.roots.push(await ensureSessionDirectory(sessionId))
  }

  return [...new Set(workspace.roots)]
}

/** Keeps the original before-state when an added source overlaps a prior root. */
export function mergeBaseline(group: CaptureGroup, files: Snapshot) {
  for (const [target, state] of Object.entries(files)) {
    if (group.baseline[target] || group.explicit.includes(target)) continue
    const covered = group.roots.some((root) => !isOutside(root, target))
    const excluded = group.excluded.some((entry) => !isOutside(entry, target))
    if (!covered || excluded) group.baseline[target] = state
  }
}

export function createGroup(
  input: BeginCapture,
  roots: string[],
): CaptureGroup {
  return {
    version: 1,
    id: input.groupId,
    sessionId: input.sessionId,
    roots,
    participants: [],
    baseline: {},
    explicit: [],
    excluded: [],
    issues: [],
    sealed: input.root === false,
    released: false,
  }
}

export function enrollParticipant(group: CaptureGroup, input: BeginCapture) {
  const participant = group.participants.find(
    (item) => item.id === input.participantId,
  )
  if (participant) {
    participant.workspace = input.workspace
  } else {
    group.participants.push({
      id: input.participantId,
      sessionId: input.sessionId,
      workspace: input.workspace,
      finished: false,
    })
  }
}

export function displayFile(group: CaptureGroup, target: string) {
  for (const participant of group.participants) {
    if (participant.workspace.sessionFiles) {
      const root = sessionDirectory(participant.sessionId)
      if (!isOutside(root, target))
        return `session://${path.relative(root, target).split(path.sep).join('/')}`
    }
    const home = participant.workspace.agentHome
    if (home && !isOutside(home.path, target))
      return `agent://${path.relative(home.path, target).split(path.sep).join('/')}`
  }
  const root = group.participants[0]?.workspace.path
  return root && !isOutside(root, target)
    ? path.relative(root, target).split(path.sep).join('/')
    : target
}

/** Removes only blobs that no checkpoint, live capture, or recovery journal references. */
export async function collectBlobs(
  storage: CheckpointStorage,
  groups: Iterable<CaptureGroup>,
) {
  const referenced = new Set<string>()
  for (const checkpoint of await storage.records<Checkpoint>('checkpoints')) {
    for (const file of checkpoint.files) {
      if (file.before) referenced.add(file.before.hash)
      if (file.after) referenced.add(file.after.hash)
    }
  }
  for (const group of groups) {
    for (const file of Object.values(group.baseline)) referenced.add(file.hash)
  }
  for (const journal of await storage.records<RestoreJournal>('journals')) {
    for (const file of journal.original) {
      if (file.before) referenced.add(file.before.hash)
      if (file.after) referenced.add(file.after.hash)
    }
  }
  await storage.collectBlobs(referenced)
}
