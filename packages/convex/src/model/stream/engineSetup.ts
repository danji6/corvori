'use node'

import { usableContextWindow } from '@cv/core/discovered-model'
import { hasInterpolation } from '@cv/core/interpreter/parse'
import { stableStringify } from '@cv/core/stable-json'
import {
  hasFilesystemTools,
  selectedBuiltinTools,
} from '@cv/core/tool-capabilities'
import { contextEnabled } from '@cv/core/tool-context'

import { internal } from '../../_generated/api'
import type { Id } from '../../_generated/dataModel'
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
import { runPromptEvaluation } from '../promptEvaluation/runner'
import {
  type CacheableRequest,
  appendOperationMessages,
  applyPromptCaching,
} from '../provider/cache'
import type { ProviderOptions } from '../provider/options'
import { getProviderOptions } from '../provider/options'
import { findCredentialsForModel } from '../provider/providers'
import { sidecarDefaultShell } from '../sidecar'
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
import {
  type ProviderHistorySnapshot,
  readHistorySnapshot,
} from './historySnapshot'
import {
  buildOperationMessages,
  buildProviderPrefix,
  createOperationPlan,
} from './operations'
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

  const capturesTools =
    invokesTools &&
    chosen.some((name) =>
      ['write_file', 'edit_file', 'shell', 'task'].includes(name),
    )
  const capturesFiles = minRole(data.invoker.role, 'admin') && capturesTools
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

  const authored = [
    ...(data.sessionCache?.promptEvaluationId ? [] : operationPlan.evalItems),
    ...operationPlan.operationPrompts,
  ]
  if (
    !capturesFiles &&
    minRole(data.invoker.role, 'admin') &&
    minRole(data.owner.role, 'admin')
  ) {
    const hasScript = authored.some(
      (item) =>
        'content' in item && item.enabled && hasInterpolation(item.content),
    )
    if (hasScript) {
      const { prepareChanges } = await import('../changes/actions')
      if (!(await prepareChanges(ctx, execution, data))) return null
    }
  }

  const evaluationOptions = {
    toolNames: current.names,
    model: data.agent.modelOverride
      ? { id: data.agent.modelOverride.modelId, label: model?.label }
      : undefined,
    deadline: windowDeadline ?? Date.now() + 60_000,
  }
  const snapshotId =
    data.sessionCache?.promptEvaluationId ??
    (await ctx.runMutation(internal.promptEvaluations._reserve, {
      ...execution,
      kind: 'snapshot',
      items: operationPlan.evalItems,
      cacheId: data.sessionCache?._id,
    }))
  if (!snapshotId) {
    await ctx.runMutation(internal.streams._handoff, execution)
    return null
  }

  const promptItems = await prepareEvaluation(
    ctx,
    execution,
    snapshotId,
    evaluationOptions,
  )
  if (!promptItems) return null
  const patch = preparedTools && operationPlan.snapshotPatch()
  if (patch) {
    const saved = await ctx.runMutation(internal.streams._saveSessionCache, {
      ...execution,
      sessionId: data.stream.sessionId,
      agentId: data.stream.agentId,
      ...patch,
      promptEvaluationId: snapshotId,
      filesystemAccess: minRole(data.invoker.role, 'admin'),
    })
    if (!saved) {
      await ctx.runMutation(internal.streams._handoff, execution)
      return null
    }
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

  let operationMessages
  if (operationPlan.operationPrompts.length) {
    const id = await ctx.runMutation(internal.promptEvaluations._reserve, {
      ...execution,
      kind: 'operation',
      items: operationPlan.operationPrompts,
    })
    if (!id) return null
    const items = await prepareEvaluation(ctx, execution, id, {
      ...evaluationOptions,
      toolNames: [],
    })
    if (!items) return null
    operationMessages = buildOperationMessages(items, data.stream.command)
  }
  const historyRows = await readHistorySnapshot(
    ctx,
    execution,
    historySnapshot ?? {},
    () => ctx.runMutation(internal.streams._handoff, execution),
  )
  if (!historyRows) return null

  const { remainingPrompts, ...prefix } = await buildProviderPrefix(
    ctx,
    data,
    promptItems,
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

async function prepareEvaluation(
  ctx: ActionCtx,
  execution: StreamExecutionArgs,
  id: Id<'promptEvaluations'>,
  options: {
    deadline: number
    toolNames: string[]
    model?: { id: string; label?: string }
  },
): Promise<PromptItem[] | null> {
  const api = internal.promptEvaluations

  const active = () => ctx.runQuery(internal.streams._isActive, execution)

  const frozen = await ctx.runQuery(api._result, { id })
  if (frozen) return (await active()) ? frozen : null

  const heartbeat = () =>
    ctx.runMutation(internal.streams._heartbeat, execution)
  const result = await runPromptEvaluation(ctx, id, {
    ...options,
    active,
    heartbeat,
  })
  if (result === 'waiting') {
    await ctx.runMutation(internal.streams._handoff, execution)
    return null
  }

  if (!(await active())) return null

  const state = await ctx.runQuery(api._get, { id })
  if (!state || state.evaluation.state === 'cancelled') {
    await ctx.runMutation(internal.streams._handoff, execution)
    return null
  }
  if (state.evaluation.state === 'failed')
    throw new Error(state.evaluation.error)

  return ctx.runQuery(api._result, { id })
}
