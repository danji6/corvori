'use node'

import type {
  ChangePublication,
  RestoreChangesResult,
} from '@cv/core/types/changes'

import { internal } from '../../_generated/api'
import type { Id } from '../../_generated/dataModel'
import type { ActionCtx } from '../../_generated/server'
import { extractErrorMessage } from '../../errors'
import { getSubject } from '../../functions'
import type { StreamContext, StreamExecutionArgs } from '../../types'
import { filesystemWorkspace } from '../tool/sessionFilesystem'
import { checkpointLocationKey, type restoreContext } from './locations'

/** Starts capture before tools can mutate files, yielding queued writers back to the scheduler. */
export async function prepareChanges(
  ctx: ActionCtx,
  execution: StreamExecutionArgs,
  data: StreamContext,
) {
  const workspace = filesystemWorkspace(data.session)

  const row = await ctx.runMutation(internal.chat._prepareChanges, {
    ...execution,
    workspace,
  })

  if (!row) return false
  if (row.phase === 'unavailable') return true

  try {
    const { postSidecar } = await import('../sidecar')
    const result = await postSidecar<{ queued: boolean }>(
      '/checkpoints/begin',
      {
        groupId: row.groupId,
        participantId: String(row.streamId),
        root: row.root,
        sessionId: row.sessionId,
        workspace,
      },
    )
    if (!result.queued) return true
    await ctx.runMutation(internal.chat._queueChanges, execution)
    return false
  } catch (error) {
    await recordIssue(ctx, row._id, error)
    return true
  }
}

export async function finishChanges(
  ctx: ActionCtx,
  args: { changeSetId: Id<'changeSets'> },
) {
  const context = await ctx.runQuery(internal.chat._changesFinishContext, args)
  if (!context) return
  const { row, pending } = context
  try {
    const { postSidecar } = await import('../sidecar')

    const result = await postSidecar<CaptureResult>('/checkpoints/finish', {
      groupId: row.groupId,
      participantId: String(row.streamId),
      checkpointId: String(row._id),
      root: row.root,
      pendingParticipants: pending,
    })

    const published = ['ready', 'empty', 'restoring', 'stale'].includes(row.phase) // prettier-ignore

    if (result.publication && !published) {
      await publish(ctx, row._id, result.publication, !row.root)
    }
    if (result.released) {
      await ctx.runMutation(internal.chat._releaseChangeGroup, {
        groupId: row.groupId,
      })
    }
    if (!row.root || (!result.publication && result.released)) {
      await ctx.runMutation(internal.chat._settleChangesCapture, {
        changeSetId: row._id,
      })
    }
    if (!result.released && row.root) {
      await ctx.runMutation(internal.chat._scheduleSettleChanges, {
        changeSetId: row._id,
      })
    }
  } catch (error) {
    await recordIssue(ctx, row._id, error)
    // Retain a durable retry: sidecar unavailability must not strand its writer reservation.
    await ctx.scheduler.runAfter(
      10_000,
      internal.actions.workspaces._finishChanges,
      args,
    )
  }
}

type CaptureResult = { publication?: ChangePublication; released: boolean }

export async function settleChanges(
  ctx: ActionCtx,
  args: { changeSetId: Id<'changeSets'>; sequence: number },
) {
  const row = await ctx.runQuery(internal.chat._getChangeSet, {
    changeSetId: args.changeSetId,
  })
  if (!row) return

  try {
    const { postSidecar } = await import('../sidecar')

    const result = await postSidecar<CaptureResult>('/checkpoints/settle', {
      groupId: row.groupId,
      checkpointId: `${row._id}:late:${args.sequence}`,
    })

    if (result.publication) {
      await publish(ctx, row._id, result.publication, true)
    }
    if (result.released) {
      await ctx.runMutation(internal.chat._releaseChangeGroup, {
        groupId: row.groupId,
      })
      return
    }
  } catch (error) {
    await recordIssue(ctx, row._id, error)
  }
  await ctx.scheduler.runAfter(
    2000,
    internal.actions.workspaces._settleChanges,
    args,
  )
}

async function publish(
  ctx: ActionCtx,
  sourceId: Id<'changeSets'>,
  value: ChangePublication,
  late: boolean,
) {
  if (late && !value.files.length) return

  const changeSetId = await ctx.runMutation(
    internal.chat._reserveChangesPublication,
    { changeSetId: sourceId, checkpointId: value.id, late },
  )
  if (!changeSetId) return

  for (let offset = 0; offset < value.files.length; offset += 32) {
    const files = []
    try {
      for (const file of value.files.slice(offset, offset + 32)) {
        const diffStorageId = await ctx.storage.store(
          new Blob([value.diffs[file.key] ?? ''], { type: 'text/plain' }),
        )
        files.push({ file, diffStorageId })
      }
      await ctx.runMutation(internal.chat._appendChanges, {
        changeSetId,
        files,
      })
    } catch (error) {
      for (const file of files) await ctx.storage.delete(file.diffStorageId)
      throw error
    }
  }

  await ctx.runMutation(internal.chat._publishChanges, {
    changeSetId,
    fileCount: value.files.length,
    additions: value.additions,
    deletions: value.deletions,
    issues: value.issues,
  })
}

type CheckpointContext = NonNullable<Awaited<ReturnType<typeof restoreContext>>>

export async function checkpointStatus(
  ctx: ActionCtx,
  { changeSetId }: { changeSetId: Id<'changeSets'> },
): Promise<{ stale: boolean }> {
  const subject = await getSubject(ctx)
  const context = await ctx.runQuery(internal.chat._changesRestoreContext, {
    changeSetId,
    subject,
  })
  if (!context) return { stale: false }
  if (context.row.phase === 'stale') return { stale: true }
  if (context.row.phase !== 'ready' || !context.row.writersSettled)
    return { stale: false }

  const { stale } = await probeCheckpointLocation(context)
  if (!stale) return { stale }

  return {
    stale: await ctx.runMutation(internal.chat._markChangesStale, {
      changeSetId,
      subject,
      locationKey: await checkpointLocationKey(context.locations),
    }),
  }
}

function checkpointReference(row: CheckpointContext['row']) {
  return {
    checkpointId: row.checkpointId ?? String(row._id),
    sessionId: row.sessionId,
  }
}

async function probeCheckpointLocation(context: CheckpointContext) {
  const { postSidecar } = await import('../sidecar')
  return postSidecar<{ stale: boolean }>('/checkpoints/location', {
    ...checkpointReference(context.row),
    locations: context.locations,
  })
}

export async function restoreChanges(
  ctx: ActionCtx,
  args: { changeSetId: Id<'changeSets'>; operationId: string },
) {
  const row = await ctx.runQuery(internal.chat._getChangeSet, {
    changeSetId: args.changeSetId,
  })
  if (
    row?.phase !== 'restoring' ||
    row.operationId !== args.operationId ||
    !row.direction
  ) {
    return
  }

  try {
    const { postSidecar } = await import('../sidecar')
    const context = await ctx.runQuery(internal.chat._changesRestoreContext, {
      changeSetId: row._id,
    })
    if (!context) throw new Error('Filesystem context is unavailable')

    const workspaces = await restoreWorkspaces(ctx, context, args)
    if (!workspaces) return

    const approvals = await ctx.runQuery(internal.sessions._getApprovals, {
      sessionId: row.sessionId,
    })

    const result = await postSidecar<RestoreChangesResult>(
      '/checkpoints/restore',
      {
        ...checkpointReference(row),
        operationId: args.operationId,
        revision: row.revision,
        direction: row.direction,
        ...workspaces,
        allowedPaths: approvals.paths ?? [],
      },
    )

    await ctx.runMutation(internal.chat._restoreChangesResult, {
      ...args,
      state: result.summary.state,
      revision: result.summary.revision,
      conflicts: result.conflicts,
      issues: result.summary.issues,
      stale: result.stale,
    })
  } catch (error) {
    await ctx.runMutation(internal.chat._restoreChangesResult, {
      ...args,
      error: extractErrorMessage(error),
    })
  }
}

async function restoreWorkspaces(
  ctx: ActionCtx,
  context: CheckpointContext,
  args: { changeSetId: Id<'changeSets'>; operationId: string },
) {
  try {
    return await resolveRestoreWorkspaces(context)
  } catch (error) {
    const location = await probeCheckpointLocation(context).catch(() => null)
    if (!location?.stale) throw error
    await ctx.runMutation(internal.chat._restoreChangesResult, {
      ...args,
      stale: true,
    })
  }
}

async function resolveRestoreWorkspaces({
  row,
  agents,
  workspace: project,
}: CheckpointContext) {
  const { resolvePersonalWorkspace } = await import('../skills/runtime')
  const resolved = await Promise.all(
    agents.map((agent) => resolvePersonalWorkspace(agent, project)),
  )
  const workspaces = resolved.filter((workspace) => workspace !== undefined)
  const current = workspaces[0] ?? project
  const workspace = row.workspace.sessionFiles
    ? filesystemWorkspace({ _id: row.sessionId, workspace: current })
    : current
  if (!workspace) throw new Error('Filesystem context is unavailable')
  return { workspace, workspaces }
}

export async function removeChanges(
  ctx: ActionCtx,
  args: { sessionId: Id<'sessions'> },
) {
  const { postSidecar } = await import('../sidecar')
  try {
    await postSidecar('/checkpoints/remove-session', args)
  } catch {
    await ctx.scheduler.runAfter(
      10_000,
      internal.actions.workspaces._removeChanges,
      args,
    )
  }
}

function recordIssue(
  ctx: ActionCtx,
  changeSetId: Id<'changeSets'>,
  error: unknown,
) {
  return ctx.runMutation(internal.chat._captureChangesIssue, {
    changeSetId,
    message: extractErrorMessage(error),
  })
}

/** Freezes normal completion before another model step or queued command can run. */
export async function finishStreamChanges(
  ctx: ActionCtx,
  execution: StreamExecutionArgs,
) {
  try {
    const row = await ctx.runQuery(internal.chat._changeSetForStream, {
      streamId: execution.streamId,
    })
    if (row) await finishChanges(ctx, { changeSetId: row._id })
  } catch {
    // The terminal mutation schedules a durable finalization attempt.
  }
}

/** Releases a delegated participant stopped before it materialized a capture row. */
export async function finishParticipantChanges(
  ctx: ActionCtx,
  args: { changeSetId: Id<'changeSets'>; participantId: string },
) {
  const row = await ctx.runQuery(internal.chat._getChangeSet, {
    changeSetId: args.changeSetId,
  })
  if (!row) return

  try {
    const { postSidecar } = await import('../sidecar')

    const result = await postSidecar<CaptureResult>('/checkpoints/finish', {
      groupId: row.groupId,
      participantId: args.participantId,
      checkpointId: `${row._id}:participant:${args.participantId}`,
      root: false,
    })

    if (result.publication) {
      await publish(ctx, row._id, result.publication, true)
    }
    if (result.released) {
      await ctx.runMutation(internal.chat._releaseChangeGroup, {
        groupId: row.groupId,
      })
    }
  } catch {
    await ctx.scheduler.runAfter(
      10_000,
      internal.actions.workspaces._finishChangesParticipant,
      args,
    )
  }
}
