'use node'

import { usableContextWindow } from '@cv/core/discovered-model'

import { internal } from '../../_generated/api'
import type { ActionCtx } from '../../_generated/server'
import type {
  StreamCommand,
  StreamExecutionArgs,
} from '../../validators/streams'
import { canCheckCompactionThreshold } from './historyBoundary'
import {
  type RequestToEstimate,
  reachesCompactionThreshold,
} from './requestTokens'

export { reachesCompactionThreshold } from './requestTokens'

type Setup = RequestToEstimate & {
  stream: { command: StreamCommand }
  modelId?: string
  contextWindow?: number
  trimContext?: boolean
}

export async function compactBeforeDispatch(
  ctx: ActionCtx,
  execution: StreamExecutionArgs,
  setup: Setup,
) {
  if (setup.trimContext) return false
  if (!canCheckCompactionThreshold(setup.stream.command)) return false
  const contextWindow = usableContextWindow(setup.contextWindow)
  if (!contextWindow || !setup.modelId) return false
  if (!(await reachesCompactionThreshold(setup, contextWindow))) return false

  return ctx.runMutation(internal.streams._compactAtThreshold, {
    ...execution,
    modelId: setup.modelId,
    contextWindow,
  })
}
