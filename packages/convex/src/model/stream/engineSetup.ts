'use node'

import { usableContextWindow } from '@cv/core/discovered-model'
import { stableStringify } from '@cv/core/stable-json'
import {
  hasFilesystemTools,
  selectedBuiltinTools,
} from '@cv/core/tool-capabilities'
import { contextEnabled } from '@cv/core/tool-context'

import { internal } from '../../_generated/api'
import type { ActionCtx } from '../../_generated/server'
import { error } from '../../errors'
import { minRole } from '../../lib/roles'
import { sharedSessionId } from '../../lib/subagent'
import type { StreamContext, StreamExecutionArgs } from '../../types'
import {
  effectiveAgentSelection,
  unavailableModelOverride,
} from '../agent/modelOverride'
import { hasSavedTitle } from '../messages'
import type { PromptItem } from '../prompt/prompts'
import {
  type CacheableRequest,
  appendOperationMessages,
  applyPromptCaching,
} from '../provider/cache'
import type { ProviderOptions } from '../provider/options'
import { getProviderOptions } from '../provider/options'
import { findCredentialsForModel } from '../provider/providers'
import { postSidecar, sidecarDefaultShell } from '../sidecar'
import { resolvePersonalWorkspace } from '../skills/runtime'
import { prepareToolAvailability } from '../tool/availability'
import { capabilitySource } from '../tool/capabilitySource'
import { resolveToolManifest } from '../tool/manifest'
import { hasToolResultMedia } from '../tool/mcpOutput'
import { filesystemWorkspace } from '../tool/sessionFilesystem'
import {
  type SessionTools,
  type ToolReplay,
  prepareSessionTools,
  prepareToolReplay,
} from '../tool/sessionTools'
import type { createCacheDiagnostics } from './cacheDiagnostics'
import { buildSessionLogBody } from './engineLog'
import { patchSessionLogBody } from './engineLog'
import { buildEvalContext } from './evalContext'
import {
  type ProviderHistorySnapshot,
  readHistorySnapshot,
} from './historySnapshot'
import {
  buildOperationMessages,
  buildProviderPrefix,
  createOperationPlan,
} from './operations'
import type { PromptEvalResult } from './operations'
import { prepareToolContext } from './toolContext'

// Keep the action's input type independent of Convex's generated API.
export type PreparedStreamStep = CacheableRequest &
  Pick<StreamContext, 'stream' | 'agent' | 'output'> & {
    modelId?: string
    contextWindow?: number
    trimContext: boolean
    outputTokens?: number
    workspace: StreamContext['session']['workspace']
    workspaceSessionId: StreamContext['session']['_id']
    isSubagent: boolean
    needsTitle: boolean
    evalResult: PromptEvalResult
    resolved: ProviderOptions
    requestLog: { body?: string }
    cacheDiagnostics?: ReturnType<typeof createCacheDiagnostics>
    tools: SessionTools['tools']
    toolChoice?: 'none'
    toolRuntime?: SessionTools
    toolReplay: ToolReplay
    hasActiveMedia: boolean
  }

export async function prepare(
  ctx: ActionCtx,
  execution: StreamExecutionArgs,
  historySnapshot?: ProviderHistorySnapshot,
  windowDeadline?: number,
): Promise<PreparedStreamStep | null> {
  let data = await ctx.runQuery(internal.streams._getContext, execution)
  if (!data) return null

  const invokesTools =
    data.stream.command.kind === 'invoke' ||
    data.stream.command.kind === 'retry'
  const chosen = selectedBuiltinTools(data.agent.tools)

  const observesToolkits =
    (invokesTools || !data.sessionCache) &&
    !!data.toolkitCount &&
    (contextEnabled('mcp', chosen) || chosen.includes('list_skills')) &&
    minRole(data.invoker.role, 'admin')
  if (observesToolkits) {
    const { observeLinkedToolkits } = await import('../toolkits/actions') // prettier-ignore
    const invalidated = new Set(await observeLinkedToolkits(ctx, execution))
    if (invalidated.size) {
      data = await ctx.runQuery(internal.streams._getContext, execution)
      if (!data) return null
    }
  }

  const { modelId, reasoningEffort } = effectiveAgentSelection(
    data.session,
    data.agent.modelOverride,
  )
  const credentials = findCredentialsForModel(data.modelProviders, modelId)
  const model = credentials?.model
  if (data.agent.modelOverride && (!model || model.available === false))
    error(unavailableModelOverride(data.agent.modelOverride.modelId), 409)

  const contextWindow = usableContextWindow(model?.contextWindow)
  const trimContext = model?.trimContext === true

  const needsPersonalWorkspace =
    hasFilesystemTools(chosen) || chosen.includes('list_skills')
  if (needsPersonalWorkspace && minRole(data.invoker.role, 'admin')) {
    data.session.workspace = await resolvePersonalWorkspace(
      data.agent,
      data.session.workspace,
    )
  }

  // Only needed while resolving a manifest
  const needsShell =
    (invokesTools || !data.sessionCache) &&
    data.agent.tools?.includes('shell') &&
    minRole(data.invoker.role, 'admin')
  const defaultShell = needsShell ? await sidecarDefaultShell() : undefined

  const capturesFiles =
    invokesTools &&
    minRole(data.invoker.role, 'admin') &&
    chosen.some((name) =>
      ['write_file', 'edit_file', 'shell', 'task'].includes(name),
    )
  if (capturesFiles) {
    const { prepareChanges } = await import('../changes/actions')
    if (!(await prepareChanges(ctx, execution, data))) return null
  }

  const availability = await prepareToolAvailability(ctx, data)
  const current = resolveToolManifest({
    ...data,
    resources: { settings: data.settings, mcpServers: data.mcpServers },
    defaultShell,
    availability,
  })
  const frozen = data.sessionCache?.tools
  const preparedTools =
    invokesTools || !frozen
      ? await prepareSessionTools(ctx, data, current, windowDeadline)
      : undefined
  const manifest = preparedTools?.frozen ?? frozen!
  const runtime = invokesTools ? preparedTools : undefined
  const { wireDefinitions, wireCalls } =
    preparedTools ?? (await prepareToolReplay(ctx, manifest, execution))
  const toolReplay = { wireDefinitions, wireCalls }
  const operationPlan = createOperationPlan(data, manifest)

  const promptEval = await evaluatePromptItems({
    data,
    items: operationPlan.evalItems,
    toolNames: current.names,
    modelLabel: model?.label,
  })
  const patch = preparedTools && operationPlan.snapshotPatch(promptEval.items)
  if (patch) {
    await ctx.runMutation(internal.streams._saveSessionCache, {
      ...execution,
      sessionId: data.stream.sessionId,
      agentId: data.stream.agentId,
      ...patch,
      filesystemAccess: minRole(data.invoker.role, 'admin'),
    })
  }

  const source = runtime ? await capabilitySource(data) : undefined
  const capabilitiesChanged =
    runtime &&
    (source !== data.sessionCache?.capabilitySource ||
      stableStringify(runtime.current) !==
        stableStringify(data.sessionCache?.effectiveTools) ||
      availability.source !== data.stream.skillCatalogSource)
  if (runtime && capabilitiesChanged) {
    const accepted = await ctx.runMutation(
      internal.streams._prepareCapabilities,
      {
        ...execution,
        source: source!,
        manifest: runtime.current,
        contextId: runtime.frozen.contextId!,
        skillCatalogSource: availability.source,
        skillAvailability: {
          skills: !!availability.skills,
        },
      },
    )
    if (!accepted) {
      await ctx.runMutation(internal.streams._handoff, execution)
      return null
    }
  }

  const contextPrepared = await prepareToolContext(
    ctx,
    execution,
    data,
    current.names,
    runtime?.frozen.contextId,
    availability,
  )
  if (!contextPrepared) return null

  const operationEval = invokesTools
    ? undefined
    : await evaluatePromptItems({
        data,
        items: operationPlan.operationPrompts,
        toolNames: [],
        modelLabel: model?.label,
        previous: promptEval,
      })
  const operationMessages = operationEval
    ? buildOperationMessages(operationEval.items, data.stream.command)
    : undefined
  const historyRows = historySnapshot
    ? await readHistorySnapshot(ctx, execution, historySnapshot)
    : undefined
  if (historyRows === null) return null

  const { remainingPrompts, ...prefix } = await buildProviderPrefix(
    ctx,
    data,
    operationPlan.requestItems(promptEval.items),
    {
      manifest,
      toolNames: current.names,
      replay: toolReplay,
      trimWindow: trimContext ? contextWindow : undefined,
      operationMessages,
      historyRows,
    },
  )

  const { createCacheDiagnostics } = await import('./cacheDiagnostics')
  const usesChatGPTContinuity =
    credentials?.providerId === 'openai' && credentials.auth === 'chatgpt'
  const cacheDiagnostics = usesChatGPTContinuity
    ? createCacheDiagnostics(ctx, {
        execution,
        messageId: data.stream.state.processingMessageId,
        attempt: data.stream.attempt,
        credentials,
      })
    : undefined
  if (!usesChatGPTContinuity && data.stream.providerContinuity) {
    await ctx.runMutation(internal.streams._clearProviderContinuity, execution)
  }

  // Apply logging after replay filtering for more accuracy
  const requestLog: { body?: string } = {}
  const resolved = await getProviderOptions(
    modelId,
    reasoningEffort,
    credentials,
    {
      placeholderResolvers: {
        cacheId: async () => {
          const { resolveStreamCacheId } = await import('./providerCacheId')
          return resolveStreamCacheId(ctx, execution, {
            sessionId: data.stream.sessionId,
            systemPrompt: prefix.systemPrompt,
            remainingPrompts,
            wireDefinitions,
          })
        },
      },
      observeTransport: cacheDiagnostics?.observeTransport,
      onRequest: async (body) => {
        requestLog.body = body
        await patchSessionLogBody(ctx, {
          body: buildSessionLogBody({ requestBody: body }),
          execution,
        })
      },
    },
  )

  const request = appendOperationMessages(
    applyPromptCaching(prefix, credentials?.providerId),
    operationMessages ?? [],
    credentials?.providerId,
  )

  return {
    stream: data.stream,
    modelId,
    contextWindow,
    trimContext,
    outputTokens: model?.outputTokens,
    agent: data.agent,
    output: data.output,
    workspace:
      invokesTools && hasFilesystemTools(current.names)
        ? filesystemWorkspace(data.session)
        : data.session.workspace,
    workspaceSessionId: sharedSessionId(data.session),
    isSubagent: !!data.session.parent,
    needsTitle:
      data.stream.command.kind === 'invoke' && !hasSavedTitle(data.session),
    evalResult: operationEval ?? promptEval,
    systemPrompt: request.systemPrompt,
    messages: request.messages,
    resolved,
    requestLog,
    cacheDiagnostics,
    tools: runtime?.tools ?? {},
    // Anthropic keys its message cache on tool choice even for read-only replay.
    toolChoice:
      invokesTools || credentials?.providerId === 'anthropic'
        ? undefined
        : ('none' as const),
    toolRuntime: runtime,
    toolReplay,
    hasActiveMedia: hasToolResultMedia(request.messages),
  }
}

type PromptEvalBatch = {
  data: StreamContext & { userCount: number; agentCount: number }
  items: PromptItem[]
  toolNames: string[]
  modelLabel?: string
  previous?: PromptEvalResult
}

async function evaluatePromptItems({
  data,
  items,
  toolNames,
  modelLabel,
  previous,
}: PromptEvalBatch): Promise<PromptEvalResult> {
  const environment = previous?.environment ?? data.environment
  if (!items.length) return { items, environment, dirty: !!previous?.dirty }

  const evalContext = buildEvalContext({
    ...data,
    model: data.agent.modelOverride
      ? { id: data.agent.modelOverride.modelId, label: modelLabel }
      : undefined,
    toolNames,
  })
  const canReadFiles = evalContext.isAdmin && toolNames.includes('read_file')
  const result = await postSidecar<PromptEvalResult>('/eval/prompts', {
    items,
    context: evalContext,
    authorizedAgentId: canReadFiles
      ? (data.session.workspace?.agentHome?.homeId ?? data.agent._id)
      : undefined,
    authorizedWorkDirs: canReadFiles ? evalContext.workDirs : undefined,
    authorizedAgentDir: canReadFiles ? evalContext.agentDir : undefined,
    authorizedWorkDir: canReadFiles ? evalContext.workDir : undefined,
    environment,
  })
  return { ...result, dirty: !!previous?.dirty || result.dirty }
}
