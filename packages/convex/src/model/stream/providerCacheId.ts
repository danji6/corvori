'use node'

import { sha256 } from '@cv/core/sha256'

import { internal } from '../../_generated/api'
import type { Id } from '../../_generated/dataModel'
import type { ActionCtx } from '../../_generated/server'
import type { StreamExecutionArgs } from '../../types'
import {
  type PromptItem,
  buildPromptMessages,
  splitHistoryPrompts,
} from '../prompt/prompts'
import type { ToolDefinition } from '../tool/manifest'

type ProviderPrefix = {
  sessionId: Id<'sessions'>
  systemPrompt?: string
  remainingPrompts: PromptItem[]
  wireDefinitions: ToolDefinition[]
}

export async function resolveStreamCacheId(
  ctx: ActionCtx,
  execution: StreamExecutionArgs,
  prefix: ProviderPrefix,
) {
  const prefixDigest = await providerPrefixDigest(prefix)
  return ctx.runMutation(internal.streams._resolveProviderCacheId, {
    ...execution,
    prefixDigest,
  })
}

/** Fingerprints the ordered prompt and tool content that precedes chat history. */
export function providerPrefixDigest({
  sessionId,
  systemPrompt,
  remainingPrompts,
  wireDefinitions,
}: ProviderPrefix) {
  const { before } = splitHistoryPrompts(remainingPrompts)
  const messages = buildPromptMessages(before, (value) => value)
  const tools = wireDefinitions.map(({ name, description, inputSchema }) => [
    name,
    description,
    JSON.parse(inputSchema),
  ])
  return sha256(JSON.stringify([sessionId, systemPrompt, messages, tools]))
}
