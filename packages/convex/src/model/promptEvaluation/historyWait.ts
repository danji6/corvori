'use node'

import { internal } from '../../_generated/api'
import type { ActionCtx } from '../../_generated/server'
import type { StreamExecutionArgs } from '../../validators/streams'
import { sleep } from '../stream/engineWatchdog'

export async function waitForPendingHistory(
  ctx: ActionCtx,
  execution: StreamExecutionArgs,
  deadline: number,
) {
  let lastHeartbeat = 0
  while (Date.now() < deadline) {
    const status = await ctx.runQuery(
      internal.promptEvaluations._pendingHistory,
      execution,
    )
    if (!status) return false
    if (status.error) throw new Error(status.error)
    if (status.needsLiveEvaluation) {
      await ctx.runMutation(internal.promptEvaluations._reserveLive, execution)
      continue
    }
    if (!status.waiting) return true
    if (Date.now() - lastHeartbeat >= 60_000) {
      await ctx.runMutation(internal.streams._heartbeat, execution)
      lastHeartbeat = Date.now()
    }
    await sleep(250)
  }
  await ctx.runMutation(internal.streams._handoff, execution)

  return false
}
