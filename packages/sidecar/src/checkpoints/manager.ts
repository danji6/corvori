import type { ChangePublication } from '@cv/core/types/changes'
import type { FolderWorkspace } from '@cv/core/types/workspace'

import { removeSessionCheckpoints } from './cleanup'
import {
  CheckpointOperations,
  CheckpointScans,
  type SnapshotOptions,
  checkpointKey,
  groupKey,
  sessionKey,
} from './coordination'
import {
  createGroup,
  enrollParticipant,
  mergeBaseline,
  overlaps,
  workspaceRoots,
} from './group'
import { hasCaptureJobs } from './jobs'
import { recoverCaptures, recoverSealedBaseline } from './recovery'
import { recoverJournal, restore } from './restore'
import { sealCheckpoint } from './seal'
import { snapshot } from './snapshot'
import { CheckpointStorage } from './storage'
import { trackFile } from './track-file'
import type {
  BeginCapture,
  CaptureGroup,
  CaptureWaiter,
  Checkpoint,
  FinishCapture,
  RestoreInput,
  RestoreJournal,
} from './types'

type CheckpointWriter = {
  trackFile: (target: string, workspace?: FolderWorkspace) => Promise<void>
  trackJob: (pid?: number) => Promise<void>
}

/** Coordinates capture groups and restoration across canonical workspace roots. */
export class CheckpointManager {
  private groups = new Map<string, CaptureGroup>()
  private waiters: CaptureWaiter[] = []
  private lastWaiterTime = 0
  private pendingCaptures = new Map<symbol, BeginCapture>()
  private initialized?: Promise<void>
  private operations = new CheckpointOperations()
  private scans: CheckpointScans

  constructor(
    readonly storage = new CheckpointStorage(),
    options: SnapshotOptions = {},
  ) {
    this.scans = new CheckpointScans(options)
  }

  async begin(input: BeginCapture) {
    const attempt = Symbol()
    this.pendingCaptures.set(attempt, input)
    try {
      await this.ready()
      let requested: string[] = []
      const roots = () => [
        ...new Set([
          ...(this.groups.get(input.groupId)?.roots ?? []),
          ...requested,
        ]),
      ]
      return await this.operations.run(
        () => ({
          roots: roots(),
          keys: [groupKey(input.groupId), sessionKey(input.sessionId)],
        }),
        () => this.beginCapture(input, roots()),
        async () => {
          requested = await workspaceRoots(input.sessionId, input.workspace)
        },
      )
    } finally {
      this.pendingCaptures.delete(attempt)
    }
  }

  private async beginCapture(input: BeginCapture, roots: string[]) {
    const existing = this.groups.get(input.groupId)
    if (existing?.released) throw new Error('Capture group has already ended')
    if (existing?.interrupted && (await hasCaptureJobs(existing)))
      return { queued: true }

    const turn = this.waiters.findIndex((waiter) => waiter.id === input.groupId)
    const earlier = this.waiters
      .slice(0, turn < 0 ? undefined : turn)
      .some((waiter) => overlaps(waiter.roots, roots))
    const busy = await this.blocked(roots, existing?.id)
    if (busy && existing) {
      throw new Error(
        'Cannot extend a capture reservation into another active workspace',
      )
    }
    if (busy || (!existing && earlier)) {
      await this.saveWaiter(input, roots, this.waiters[turn])
      return { queued: true }
    }

    await this.removeWaiter(input.groupId)

    const group = existing
      ? structuredClone(existing)
      : createGroup(input, roots)

    await recoverSealedBaseline(this.storage, group)
    await this.captureBaseline(group, roots, !!existing)
    enrollParticipant(group, input)

    if (group.interrupted) {
      group.interrupted = false
      group.shellPids = []
    }

    try {
      await this.saveGroup(group)
    } catch (error) {
      await this.fenceFailedCapture(group)
      throw error
    }
    this.groups.set(group.id, group)
    return { queued: false }
  }

  private async fenceFailedCapture(group: CaptureGroup) {
    // Rename can succeed before a directory sync fails. Keep any such
    // reservation fenced and reconcile it on the next begin.
    const stored = await this.storage
      .read<CaptureGroup>('groups', group.id)
      .catch(() => group)
    if (stored) this.groups.set(group.id, { ...stored, interrupted: true })
  }

  private async saveWaiter(
    input: BeginCapture,
    roots: string[],
    previous?: CaptureWaiter,
  ) {
    if (
      previous &&
      roots.length === previous.roots.length &&
      roots.every((root) => previous.roots.includes(root))
    )
      return
    const waiter = {
      id: input.groupId,
      roots,
      createdAt: previous?.createdAt ?? this.nextWaiterTime(),
      sessionId: input.sessionId,
    }
    await this.storage.save('waiters', waiter.id, waiter)
    if (previous) Object.assign(previous, waiter)
    else this.waiters.push(waiter)
  }

  private nextWaiterTime() {
    this.lastWaiterTime = Math.max(Date.now(), this.lastWaiterTime + 1)
    return this.lastWaiterTime
  }

  private async removeWaiter(id: string) {
    if (!this.waiters.some((waiter) => waiter.id === id)) return
    await this.storage.remove('waiters', id)
    this.waiters = this.waiters.filter((waiter) => waiter.id !== id)
  }

  private async captureBaseline(
    group: CaptureGroup,
    roots: string[],
    existing: boolean,
  ) {
    const added = existing
      ? roots.filter((root) => !group.roots.includes(root))
      : roots
    if (added.length) {
      const captured = await this.scans.run('begin', () =>
        snapshot(this.storage, added),
      )
      if (existing) mergeBaseline(group, captured.files)
      else group.baseline = captured.files
      group.issues.push(...captured.issues)
      group.excluded.push(...captured.excluded)
      group.unavailable = [
        ...(group.unavailable ?? []),
        ...captured.unavailable,
      ]
    }
    group.roots = roots
  }

  /** Holds the actual write scope through file tracking or shell registration. */
  async write<T>(
    sessionId: string,
    roots: string[],
    fn: (writer: CheckpointWriter) => Promise<T>,
  ) {
    await this.ready()
    return this.operations.run(
      () => ({
        roots,
        keys: [sessionKey(sessionId), ...this.sessionGroupKeys(sessionId)],
      }),
      async () => {
        const group = this.forSession(sessionId)
        if (await this.blocked(roots, group?.id))
          throw new Error('Workspace is reserved by another agent turn')
        if (group?.interrupted)
          throw new Error(
            'Workspace capture was interrupted; wait for reconciliation',
          )
        return fn({
          trackFile: (target, workspace) =>
            trackFile(this.storage, roots, group, target, workspace),
          trackJob: (pid) => this.trackJob(group, pid),
        })
      },
    )
  }

  finish(input: FinishCapture) {
    return this.finalize(input.groupId, input.checkpointId, async () => {
      const saved = await this.storage.read<Checkpoint>(
        'checkpoints',
        input.checkpointId,
      )
      if (saved) return this.finishSaved(input.groupId, saved)

      const group = this.groups.get(input.groupId)
      if (!group) {
        await this.removeWaiter(input.groupId)
        return { released: true }
      }
      if (group.released) return { released: true }
      await recoverSealedBaseline(this.storage, group)

      for (const id of input.pendingParticipants ?? []) {
        if (!group.participants.some((item) => item.id === id)) {
          const first = group.participants[0]!
          group.participants.push({ ...first, id, finished: false })
        }
      }

      const participant = group.participants.find(
        (item) => item.id === input.participantId,
      )
      if (participant?.completedCheckpoint === input.checkpointId)
        return { released: await this.releaseIfFinished(group) }
      if (participant) participant.finished = true

      let result: ChangePublication | undefined
      const shouldSeal = input.root || group.sealed
      if (input.root) group.sealed = true
      if (shouldSeal) result = await this.seal(group, input.checkpointId)
      if (participant) participant.completedCheckpoint = input.checkpointId

      const released = await this.releaseIfFinished(group)

      return { publication: result, released }
    })
  }

  private async finalize<T>(
    groupId: string,
    checkpointId: string,
    operation: () => Promise<T>,
  ) {
    await this.ready()
    return this.operations.run(
      () => ({
        roots: this.groups.get(groupId)?.roots,
        keys: [groupKey(groupId), checkpointKey(checkpointId)],
      }),
      operation,
    )
  }

  async read(checkpointId: string) {
    await this.ready()
    return this.operations.run(
      () => ({ keys: [checkpointKey(checkpointId)] }),
      () => this.storage.read<Checkpoint>('checkpoints', checkpointId),
    )
  }

  async restore(input: RestoreInput) {
    const initial = await this.read(input.checkpointId)
    if (!initial || initial.sessionId !== input.sessionId)
      throw new Error('Checkpoint not found')

    return this.operations.run(
      () => ({ roots: initial.roots, keys: [checkpointKey(initial.id)] }),
      () => this.restoreCheckpoint(input),
    )
  }

  private async restoreCheckpoint(input: RestoreInput) {
    const checkpoint = await this.storage.read<Checkpoint>(
      'checkpoints',
      input.checkpointId,
    )
    if (!checkpoint || checkpoint.sessionId !== input.sessionId)
      throw new Error('Checkpoint not found')

    if (await this.blocked(checkpoint.roots, undefined, checkpoint.id))
      throw new Error(
        'Wait for workspace writers to finish before restoring changes',
      )

    const journal = await this.storage.read<RestoreJournal>(
      'journals',
      checkpoint.id,
    )
    if (journal) await recoverJournal(this.storage, journal)
    return restore(this.storage, checkpoint, input)
  }

  /** Checks lingering jobs after their turn has ended and seals only their new delta. */
  settle(groupId: string, checkpointId: string) {
    return this.finalize(groupId, checkpointId, async () => {
      const saved = await this.storage.read<Checkpoint>(
        'checkpoints',
        checkpointId,
      )
      if (saved) return this.finishSaved(groupId, saved)

      const group = this.groups.get(groupId)
      if (!group || group.released) return { released: true }
      const pending = group.participants.some((participant) => !participant.finished) // prettier-ignore
      if (pending || (await hasCaptureJobs(group))) return { released: false }
      await recoverSealedBaseline(this.storage, group)

      const result = group.sealed
        ? await this.seal(group, checkpointId)
        : undefined

      const released = await this.releaseIfFinished(group)

      return { publication: result, released }
    })
  }

  async removeSession(sessionId: string) {
    await this.ready()
    return this.operations.run(
      () => ({ exclusive: true }),
      async () => {
        for (const waiter of this.waiters) {
          if (waiter.sessionId === sessionId) await this.removeWaiter(waiter.id)
        }
        await removeSessionCheckpoints(this.storage, this.groups, sessionId)
      },
    )
  }

  private async trackJob(group: CaptureGroup | undefined, pid?: number) {
    if (!group || !pid) return
    group.shellPids = [...new Set([...(group.shellPids ?? []), pid])]
    await this.saveGroup(group)
  }

  async finishJob(sessionId: string, pid?: number) {
    if (!pid) return
    await this.ready()
    return this.operations.run(
      () => ({
        keys: [sessionKey(sessionId), ...this.sessionGroupKeys(sessionId)],
      }),
      async () => {
        for (const group of this.sessionGroups(sessionId)) {
          if (!group.shellPids?.includes(pid)) continue
          const shellPids = group.shellPids.filter((item) => item !== pid)
          await this.saveGroup({ ...group, shellPids })
          group.shellPids = shellPids
        }
      },
    )
  }

  async homeReserved(homeId: string) {
    await this.ready()
    const usesHome = (workspace: FolderWorkspace) =>
      (workspace.agentHome?.homeId ?? workspace.agentHome?.agentId) === homeId
    return (
      [...this.pendingCaptures.values()].some((input) =>
        usesHome(input.workspace),
      ) ||
      [...this.groups.values()].some(
        (group) =>
          !group.released &&
          group.participants.some((participant) =>
            usesHome(participant.workspace),
          ),
      )
    )
  }

  async reserved(sessionId: string) {
    await this.ready()
    return (
      [...this.pendingCaptures.values()].some(
        (input) => input.sessionId === sessionId,
      ) || this.sessionGroups(sessionId).some((group) => !group.released)
    )
  }

  private sessionGroups(sessionId: string) {
    return [...this.groups.values()].filter((group) =>
      group.participants.some(
        (participant) => participant.sessionId === sessionId,
      ),
    )
  }

  private sessionGroupKeys(sessionId: string) {
    return this.sessionGroups(sessionId).map((group) => groupKey(group.id))
  }

  private forSession(sessionId: string) {
    return [...this.groups.values()].find(
      (group) =>
        !group.released &&
        group.participants.some(
          (item) => item.sessionId === sessionId && !item.finished,
        ),
    )
  }

  private ready() {
    return (this.initialized ??= this.initialize())
  }

  private async initialize() {
    const recovered = await recoverCaptures(this.storage)
    this.waiters = recovered.waiters
    this.lastWaiterTime = this.waiters.at(-1)?.createdAt ?? 0
    this.groups = recovered.groups
  }

  private async blocked(roots: string[], except?: string, journalId?: string) {
    const { hasRunningWorkspaceJobs } = await import('../shell/registry')

    const ownerSessions = except
      ? (this.groups.get(except)?.participants.map((item) => item.sessionId) ?? []) // prettier-ignore
      : []
    if (hasRunningWorkspaceJobs(roots, ownerSessions)) return true

    const busy = [...this.groups.values()].some(
      (group) =>
        !group.released && group.id !== except && overlaps(group.roots, roots),
    )
    if (busy) return true

    return (await this.storage.records<RestoreJournal>('journals')).some(
      (journal) =>
        journal.checkpointId !== journalId && overlaps(journal.roots, roots),
    )
  }

  private seal(group: CaptureGroup, id: string) {
    return sealCheckpoint(this.storage, this.scans, group, id)
  }

  private async finishSaved(groupId: string, checkpoint: Checkpoint) {
    if (checkpoint.groupId !== groupId)
      throw new Error('Checkpoint belongs to another capture group')
    const group = this.groups.get(groupId)
    if (group?.pendingCheckpoint === checkpoint.id)
      await recoverSealedBaseline(this.storage, group)
    return {
      publication: checkpoint.publication,
      released: group ? await this.releaseIfFinished(group) : true,
    }
  }

  private async releaseIfFinished(group: CaptureGroup) {
    if (group.released) return true
    const finished = group.participants.every(
      (participant) => participant.finished,
    )
    const released = finished && !(await hasCaptureJobs(group))
    await this.saveGroup({ ...group, released })
    group.released = released
    return released
  }

  private saveGroup(group: CaptureGroup) {
    return this.storage.save('groups', group.id, group)
  }
}

let manager: CheckpointManager | undefined
export function checkpoints() {
  return (manager ??= new CheckpointManager())
}

export async function finishCheckpointJob(sessionId: string, pid?: number) {
  await manager?.finishJob(sessionId, pid)
}
