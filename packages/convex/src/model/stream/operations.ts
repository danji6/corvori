'use node'

import type { ModelMessage } from '@ai-sdk/provider-utils'

import type { Doc } from '../../_generated/dataModel'
import type { ActionCtx } from '../../_generated/server'
import type { StreamContext } from '../../types'
import type { MessageWithParts } from '../messageContents'
import {
  buildExtraInstructions,
  buildPromptMessages,
  buildSystemPrompt,
  mergePrompts,
  removeStarterPrompts,
  resolveCompactionPrompts,
  resolveImpersonationPrompts,
} from '../prompt/prompts'
import type { PromptItem } from '../prompt/prompts'
import { type SnapshotPatch, planSnapshotEval } from '../prompt/snapshots'
import type { ToolManifest } from '../tool/manifest'
import type { ToolReplay } from '../tool/sessionTools'
import { buildProviderHistory } from './history'

export type PromptEvalResult = {
  items: PromptItem[]
  environment: Record<string, unknown>
  dirty: boolean
}

type CachePatch = SnapshotPatch & {
  tools?: ToolManifest
  historyPresentation?: Doc<'sessionCache'>['historyPresentation']
}

export function createOperationPlan(
  data: StreamContext,
  manifest: ToolManifest,
) {
  const prompts = removeStarterPrompts(
    mergePrompts(
      { ...data.agent, prompts: data.prompts.own },
      data.prompts.library,
    ),
  )
  const plan = planSnapshotEval({ cache: data.sessionCache, prompts })
  const operationPrompts = resolveOperationPrompts(data)

  return {
    ...plan,
    operationPrompts,
    snapshotPatch: (evaluated: PromptItem[]): CachePatch | null => {
      const patch = plan.snapshotPatch(evaluated)
      const capturesTools = manifest !== data.sessionCache?.tools
      const presentation = data.sessionCache?.historyPresentation
      if (!patch && !capturesTools && presentation) return null
      return {
        ...patch,
        ...(capturesTools ? { tools: manifest } : {}),
        ...(presentation
          ? {}
          : { historyPresentation: historyPresentation(data) }),
      }
    },
  }
}

function historyPresentation({ agent }: StreamContext) {
  return {
    maskOtherAgents: !!agent.maskOtherAgents,
    shareUserDisplayNames: !!agent.shareUserDisplayNames,
    shareAgentDisplayNames: !!agent.shareAgentDisplayNames,
  }
}

function resolveOperationPrompts({ stream, prompts }: StreamContext) {
  const { command } = stream
  if (command.kind === 'compact')
    return resolveCompactionPrompts(prompts.compaction)
  if (command.kind === 'impersonate')
    return resolveImpersonationPrompts(prompts.impersonation)
  return []
}

type PrefixOptions = {
  manifest: ToolManifest
  toolNames: string[]
  replay: ToolReplay
  trimWindow?: number
  operationMessages?: ModelMessage[]
  historyRows?: MessageWithParts[]
}

/** Builds the chat prefix before adding any operation-specific instructions. */
export async function buildProviderPrefix(
  ctx: ActionCtx,
  data: StreamContext,
  prompts: PromptItem[],
  {
    manifest,
    toolNames,
    replay,
    trimWindow,
    operationMessages,
    historyRows,
  }: PrefixOptions,
) {
  const { systemPrompt, remainingPrompts } = buildSystemPrompt(
    prompts,
    (value) => value,
  )
  const messages = await buildProviderHistory(ctx, data, remainingPrompts, {
    toolNames,
    manifestVersion: manifest.version ?? 1,
    contextId: manifest.contextId,
    replay,
    historyRows,
    trim: trimWindow
      ? {
          contextWindow: trimWindow,
          systemPrompt,
          messages: operationMessages ?? [],
          enforceContextWindow: operationMessages !== undefined,
          tools: {},
          toolReplay: replay,
        }
      : undefined,
  })
  return { systemPrompt, messages, remainingPrompts }
}

export function buildOperationMessages(
  items: PromptItem[],
  command: StreamContext['stream']['command'],
) {
  const messages = buildPromptMessages(items, (value) => value)
  if (command.kind !== 'compact' && command.kind !== 'impersonate')
    return messages

  const instructions = buildExtraInstructions(command.instructions)
  if (instructions) messages.push({ role: 'user', content: instructions })
  return messages
}
