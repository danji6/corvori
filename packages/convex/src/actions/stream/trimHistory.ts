'use node'

import type { ModelMessage } from '@ai-sdk/provider-utils'

import { estimateTokens } from '../../model/context'
import { insertApprovalNoteMessages } from './historyApprovals'
import {
  type RequestToEstimate,
  contextThreshold,
  estimateMessageTokens,
  estimateToolTokens,
  requestToolDefinitions,
} from './requestTokens'

export type TrimHistoryOptions = RequestToEstimate & { contextWindow: number }

/** Removes whole history turns while keeping the latest input and its replies. */
export async function trimProviderHistory(
  history: ModelMessage[],
  fixed: TrimHistoryOptions,
  approvalNotes = new Map<string, string>(),
) {
  const turns = groupTurns(history).map((turn) =>
    insertApprovalNoteMessages(turn, approvalNotes),
  )
  if (turns.length <= 1) return turns.flat()
  const costs = await Promise.all(
    turns.map(async (turn) => {
      const costs = await Promise.all(
        turn.map((message) =>
          estimateMessageTokens(message, fixed.toolRuntime),
        ),
      )
      return costs.reduce((total, cost) => total + cost, 0)
    }),
  )
  let total =
    (await fixedTokens(fixed)) + costs.reduce((sum, cost) => sum + cost, 0)
  const threshold = contextThreshold(fixed.contextWindow)
  let start = 0

  while (total > threshold && start < turns.length - 1) {
    total -= costs[start++]
  }

  return turns.slice(start).flat()
}

function groupTurns(history: ModelMessage[]) {
  const turns: ModelMessage[][] = []
  let start = 0
  let hasReply = false

  for (const [index, message] of history.entries()) {
    if (message.role === 'assistant') hasReply = true
    if (message.role === 'user' && hasReply) {
      turns.push(history.slice(start, index))
      start = index
      hasReply = false
    }
  }

  if (start < history.length) turns.push(history.slice(start))
  return turns
}

async function fixedTokens(request: RequestToEstimate) {
  const definitions = await requestToolDefinitions(request)
  const costs = await Promise.all([
    estimateTokens(request.systemPrompt ?? ''),
    ...request.messages.map((message) =>
      estimateMessageTokens(message, request.toolRuntime),
    ),
    ...definitions.map(estimateToolTokens),
  ])
  return costs.reduce((sum, cost) => sum + cost, 0)
}
