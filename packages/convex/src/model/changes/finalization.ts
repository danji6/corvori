import { internal } from '../../_generated/api'
import type { Doc } from '../../_generated/dataModel'
import type { MutationCtx } from '../../_generated/server'
import type { ContinueChangesFinalizationArgs } from '../../validators/changes'

const FINISH_RETRY_MS = 10_000
const SETTLE_RETRY_MS = 2_000
const RECOVERY_PAGE_SIZE = 32

export async function scheduleFinalizationIfIdle(
  ctx: MutationCtx,
  row: Doc<'changeSets'>,
) {
  if (row.writersSettled) return
  const state = await finalizationJobState(ctx, row)
  if (state === 'pending' || state === 'inProgress') return
  await scheduleFinalization(ctx, row, 0, row.settleScheduled ? 0 : undefined)
}

/** Replaces the current attempt only if no successor has already been queued. */
export async function continueFinalization(
  ctx: MutationCtx,
  args: ContinueChangesFinalizationArgs,
) {
  const row = await ctx.db.get(args.changeSetId)
  if (!row || row.writersSettled) return
  if (row.finalizationJobId !== args.expectedJobId) return
  if ((await finalizationJobState(ctx, row)) === 'pending') return

  const sequence = args.settlementSequence
  const delay = sequence === undefined ? FINISH_RETRY_MS : SETTLE_RETRY_MS
  await scheduleFinalization(ctx, row, delay, sequence)
}

/** Replays finalization for ended turns after the scheduler loses an action. */
export async function reconcileFinishedChanges(
  ctx: MutationCtx,
  { cursor }: { cursor?: string },
) {
  const result = await ctx.db
    .query('changeSets')
    .withIndex('by_finished_writersSettled', (q) =>
      q.eq('finished', true).lt('writersSettled', true),
    )
    .paginate({ numItems: RECOVERY_PAGE_SIZE, cursor: cursor ?? null })

  for (const row of result.page) {
    // Late publications reuse the stream ID but own no capture participant.
    if (row.checkpointId && row.checkpointId !== row._id) continue
    if (await ctx.db.get(row.streamId)) continue
    await scheduleFinalizationIfIdle(ctx, row)
  }

  if (!result.isDone) {
    await ctx.scheduler.runAfter(0, internal.chat._reconcileFinishedChanges, {
      cursor: result.continueCursor,
    })
  }
}

async function finalizationJobState(ctx: MutationCtx, row: Doc<'changeSets'>) {
  if (!row.finalizationJobId) return undefined
  const job = await ctx.db.system.get(
    '_scheduled_functions',
    row.finalizationJobId,
  )
  return job?.state.kind
}

async function scheduleFinalization(
  ctx: MutationCtx,
  row: Doc<'changeSets'>,
  delay: number,
  settlementSequence?: number,
) {
  const args = { changeSetId: row._id }
  if (settlementSequence === undefined) {
    const finalizationJobId = await ctx.scheduler.runAfter(
      delay,
      internal.actions.workspaces._finishChanges,
      args,
    )
    await ctx.db.patch(row._id, { finalizationJobId })
    return
  }

  const finalizationJobId = await ctx.scheduler.runAfter(
    delay,
    internal.actions.workspaces._settleChanges,
    { ...args, sequence: settlementSequence },
  )
  await ctx.db.patch(row._id, { finalizationJobId, settleScheduled: true })
}
