'use node'

import type { ToolSet } from 'ai'

import type { Doc } from '../../_generated/dataModel'
import type { ActionCtx } from '../../_generated/server'
import {
  buildExtraInstructions,
  buildPromptMessages,
  buildSystemPrompt,
  mergePrompts,
  removeStarterPrompts,
  resolveCompactionPrompts,
  resolveImpersonationPrompts,
} from '../../model/prompt/prompts'
import type { PromptItem } from '../../model/prompt/prompts'
import {
  type SnapshotPatch,
  planSnapshotEval,
} from '../../model/prompt/snapshots'
import {
  type ToolManifest,
  resolveToolManifest,
} from '../../model/tool/manifest'
import type { ToolAvailability } from '../../model/tool/manifest'
import type { SessionTools } from '../../model/tool/sessionTools'
import type { ToolResources } from '../../model/tool/settings'
import type { Prompt, StreamContext } from '../../types'
import { buildProviderHistory } from './history'

export type PromptEvalResult = {
  items: PromptItem[]
  environment: Record<string, unknown>
  dirty: boolean
}

export type ProviderRequest = {
  toolRuntime?: SessionTools
  systemPrompt: string | undefined
  messages: Awaited<ReturnType<typeof buildProviderHistory>>
  tools: ToolSet
}

type OperationPlan = {
  evalItems: PromptItem[]
  /** Tool names exposed to the prompt interpreter's `tools` binding. */
  toolNames: string[]
  /** Cache row patch to persist; null for one-shot operations. */
  snapshotPatch: (evalResult: PromptEvalResult) => CachePatch | null
  buildRequest: (
    ctx: ActionCtx,
    data: StreamContext,
    evalResult: PromptEvalResult,
    trimWindow?: number,
  ) => Promise<ProviderRequest>
}

type CachePatch = SnapshotPatch & {
  tools?: ToolManifest
  historyPresentation?: Doc<'sessionCache'>['historyPresentation']
}

/** The web and MCP resources the tool builders read. */
export function toolResources(data: StreamContext): ToolResources {
  return { settings: data.settings, mcpServers: data.mcpServers }
}

export function createOperationPlan(
  data: StreamContext,
  defaultShell?: string,
  availability?: ToolAvailability,
  runtime?: SessionTools,
): OperationPlan {
  const prompts = removeStarterPrompts(
    mergePrompts(
      { ...data.agent, prompts: data.prompts.own },
      data.prompts.library,
    ),
  )

  if (data.stream.command.kind === 'compact') {
    return createAppendPlan(
      prompts,
      resolveCompactionPrompts(data.prompts.compaction),
      data.stream.command.instructions,
    )
  }

  if (data.stream.command.kind === 'impersonate') {
    return createAppendPlan(
      prompts,
      resolveImpersonationPrompts(data.prompts.impersonation),
      data.stream.command.instructions,
    )
  }

  return createInvokePlan(data, prompts, defaultShell, availability, runtime)
}

function createInvokePlan(
  data: StreamContext,
  prompts: PromptItem[],
  defaultShell?: string,
  availability?: ToolAvailability,
  runtime?: SessionTools,
): OperationPlan {
  const plan = planSnapshotEval({ cache: data.sessionCache, prompts })

  // Cached on first invoke, then reused for the rest of the session
  const frozenTools = data.sessionCache?.tools
  const frozenPresentation = data.sessionCache?.historyPresentation
  const historyPresentation = frozenPresentation ?? {
    maskOtherAgents: !!data.agent.maskOtherAgents,
    shareUserDisplayNames: !!data.agent.shareUserDisplayNames,
    shareAgentDisplayNames: !!data.agent.shareAgentDisplayNames,
  }
  const manifest =
    runtime?.frozen ??
    frozenTools ??
    resolveToolManifest({
      ...data,
      resources: toolResources(data),
      defaultShell,
      availability,
    })

  return {
    evalItems: plan.evalItems,
    toolNames: runtime?.current.names ?? manifest.names,
    snapshotPatch: (evalResult) => {
      const patch = plan.snapshotPatch(evalResult.items)
      const capturesTools = manifest !== frozenTools
      if (!patch && !capturesTools && frozenPresentation) return null
      return {
        ...patch,
        ...(capturesTools ? { tools: manifest } : {}),
        ...(frozenPresentation ? {} : { historyPresentation }),
      }
    },
    buildRequest: (ctx, data, evalResult, trimWindow) =>
      buildInvokeRequest(
        ctx,
        data,
        plan.requestItems(evalResult.items),
        manifest,
        runtime,
        trimWindow,
      ),
  }
}

/** Evaluates the agent context first, then the operation's trailing prompts. */
function createAppendPlan(
  prompts: PromptItem[],
  operationPrompts: Prompt[],
  instructions?: string,
): OperationPlan {
  return {
    evalItems: [...prompts, ...operationPrompts],
    toolNames: [],
    snapshotPatch: () => null,
    buildRequest: (ctx, data, evalResult, trimWindow) =>
      buildAppendRequest(
        ctx,
        data,
        evalResult.items.slice(0, prompts.length),
        evalResult.items.slice(prompts.length),
        instructions,
        trimWindow,
      ),
  }
}

async function buildInvokeRequest(
  ctx: ActionCtx,
  data: StreamContext,
  prompts: PromptItem[],
  manifest: ToolManifest,
  runtime?: SessionTools,
  trimWindow?: number,
): Promise<ProviderRequest> {
  const { systemPrompt, remainingPrompts } = buildSystemPrompt(
    prompts,
    (value) => value,
  )
  const tools = runtime?.tools ?? (await buildRequestTools(ctx, data, manifest))
  const messages = await buildProviderHistory(ctx, data, remainingPrompts, {
    toolNames: runtime?.current.names ?? manifest.names,
    manifestVersion: manifest.version ?? 1,
    contextId: manifest.contextId,
    runtime,
    trim: trimWindow
      ? {
          contextWindow: trimWindow,
          systemPrompt,
          messages: [],
          tools,
          toolRuntime: runtime,
        }
      : undefined,
  })
  return { systemPrompt, messages, toolRuntime: runtime, tools }
}

async function buildRequestTools(
  ctx: ActionCtx,
  data: StreamContext,
  manifest: ToolManifest,
) {
  const { getEnabledTools } = await import('../../model/tool/build')
  return getEnabledTools(
    manifest,
    { ...data.session, toolApprovals: data.toolApprovals },
    toolResources(data),
    {
      ctx,
      autoApprove: data.agent.autoApprove,
      omitMcpMedia: data.stream.omitActiveMedia,
      messageId: data.output._id,
      messageCreatedAt: data.output._creationTime,
      agentId: data.agent._id,
      invokedBy: data.stream.invokedBy,
      execution: {
        streamId: data.stream._id,
        generation: data.stream.generation,
      },
    },
  )
}

/** Appends operation instructions after the complete agent/history layout. */
async function buildAppendRequest(
  ctx: ActionCtx,
  data: StreamContext,
  prompts: PromptItem[],
  operationPrompts: PromptItem[],
  instructions?: string,
  trimWindow?: number,
): Promise<ProviderRequest> {
  const { systemPrompt, remainingPrompts } = buildSystemPrompt(
    prompts,
    (value) => value,
  )
  const trailing = buildPromptMessages(operationPrompts, (value) => value)
  const extraInstructions = buildExtraInstructions(instructions)
  if (extraInstructions) {
    trailing.push({ role: 'user', content: extraInstructions })
  }

  const messages = await buildProviderHistory(ctx, data, remainingPrompts, {
    trim: trimWindow
      ? {
          contextWindow: trimWindow,
          systemPrompt,
          messages: trailing,
          tools: {},
        }
      : undefined,
  })
  return {
    systemPrompt,
    messages: [...messages, ...trailing],
    tools: {},
  }
}
