'use node'

import { type Value, convexToJson } from 'convex/values'

import { internal } from '../../_generated/api'
import type { ActionCtx } from '../../_generated/server'
import type { StreamExecutionArgs } from '../../types'
import type { MessageWithParts } from '../messageContents'
import { assembleProviderHistory } from './providerHistory'

const MAX_HISTORY_SNAPSHOT_BYTES = 2 * 1024 * 1024

export type ProviderHistorySnapshot = {
  completed?: { identity: string; rows: MessageWithParts[] }
}

/** Retains only stored history within this stream action's budget. */
export async function readHistorySnapshot(
  ctx: ActionCtx,
  execution: StreamExecutionArgs,
  snapshot: ProviderHistorySnapshot,
) {
  const result = await ctx.runQuery(
    internal.streams._getProviderHistorySnapshot,
    {
      ...execution,
      knownHistory: snapshot.completed?.identity,
    },
  )
  if (!result) {
    snapshot.completed = undefined
    return null
  }

  if (result.completed) {
    snapshot.completed =
      Buffer.byteLength(
        JSON.stringify(convexToJson(result.completed as Value)),
      ) <= MAX_HISTORY_SNAPSHOT_BYTES
        ? { identity: result.identity, rows: result.completed }
        : undefined
  }
  const completed = result.completed ?? snapshot.completed!.rows
  return assembleProviderHistory(completed, result.live)
}
