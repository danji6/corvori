'use node'

import type { ModelMessage } from '@ai-sdk/provider-utils'
import { usableContextWindow } from '@cv/core/discovered-model'

import { internal } from '../../_generated/api'
import { error } from '../../errors'
import {
  effectiveAgentSelection,
  unavailableModelOverride,
} from '../agent/modelOverride'
import type { PromptItem } from '../prompt/prompts'
import { appendOperationMessages, applyPromptCaching } from '../provider/cache'
import { getProviderOptions } from '../provider/options'
import { findCredentialsForModel } from '../provider/providers'
import { buildSessionLogBody, patchSessionLogBody } from './engineLog'
import type { PreparedStepTools, StepContext } from './engineTools'
import {
  type ProviderHistorySnapshot,
  readHistorySnapshot,
} from './historySnapshot'
import { buildProviderPrefix } from './operations'
import type { resolveStreamCacheId } from './providerCacheId'
import type { StreamContext } from './types'

export function resolveStepModel(data: StreamContext) {
  const { modelOverride } = data.agent
  const { modelId, reasoningEffort } = effectiveAgentSelection(
    data.session,
    modelOverride,
  )
  const credentials = findCredentialsForModel(data.modelProviders, modelId)
  const model = credentials?.model
  if (modelOverride && (!model || model.available === false)) {
    error(unavailableModelOverride(modelOverride.modelId), 409)
  }

  return {
    modelId,
    reasoningEffort,
    credentials,
    contextWindow: usableContextWindow(model?.contextWindow),
    trimContext: model?.trimContext === true,
  }
}

export type StepModel = ReturnType<typeof resolveStepModel>

type RequestInput = {
  promptItems: PromptItem[]
  operationMessages?: ModelMessage[]
  historySnapshot?: ProviderHistorySnapshot
}

export async function prepareProviderRequest(
  step: StepContext,
  model: StepModel,
  tools: PreparedStepTools,
  input: RequestInput,
) {
  const built = await prepareRequestPrefix(step, model, tools, input)
  if (!built) return null

  const { remainingPrompts, ...prefix } = built
  const transport = await configureProviderRequest(step, model, {
    sessionId: step.data.stream.sessionId,
    systemPrompt: prefix.systemPrompt,
    remainingPrompts,
    wireDefinitions: tools.replay.wireDefinitions,
  })

  const providerId = model.credentials?.providerId
  const request = appendOperationMessages(
    applyPromptCaching(prefix, providerId),
    input.operationMessages ?? [],
    providerId,
  )
  return { ...request, ...transport }
}

export type PreparedProviderRequest = NonNullable<
  Awaited<ReturnType<typeof prepareProviderRequest>>
>

async function prepareRequestPrefix(
  { ctx, execution, data }: StepContext,
  { contextWindow, trimContext }: StepModel,
  { names, manifest, replay }: PreparedStepTools,
  { promptItems, operationMessages, historySnapshot }: RequestInput,
) {
  const historyRows = await readHistorySnapshot(
    ctx,
    execution,
    historySnapshot ?? {},
    () => ctx.runMutation(internal.streams._handoff, execution),
  )
  if (!historyRows) return null

  return buildProviderPrefix(ctx, data, promptItems, {
    manifest,
    toolNames: names,
    replay,
    trimWindow: trimContext ? contextWindow : undefined,
    operationMessages,
    historyRows,
  })
}

async function configureProviderRequest(
  step: StepContext,
  { modelId, reasoningEffort, credentials }: StepModel,
  prefix: Parameters<typeof resolveStreamCacheId>[2],
) {
  const { ctx, execution } = step
  const cacheDiagnostics = await prepareCacheDiagnostics(step, credentials)

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
          return resolveStreamCacheId(ctx, execution, prefix)
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
  return { resolved, requestLog, cacheDiagnostics }
}

async function prepareCacheDiagnostics(
  { ctx, execution, data }: StepContext,
  credentials: StepModel['credentials'],
) {
  const { createCacheDiagnostics } = await import('./cacheDiagnostics')
  if (credentials?.providerId === 'openai' && credentials.auth === 'chatgpt') {
    return createCacheDiagnostics(ctx, {
      execution,
      messageId: data.stream.state.processingMessageId,
      attempt: data.stream.attempt,
      credentials,
    })
  }
  if (data.stream.providerContinuity) {
    await ctx.runMutation(internal.streams._clearProviderContinuity, execution)
  }
}
