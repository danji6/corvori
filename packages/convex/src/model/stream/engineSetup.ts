'use node'

import { hasFilesystemTools } from '@cv/core/tool-capabilities'

import type { ActionCtx } from '../../_generated/server'
import { sharedSessionId } from '../../lib/subagent'
import type { StreamExecutionArgs } from '../../validators/streams'
import { hasSavedTitle } from '../messages'
import type { CacheableRequest } from '../provider/cache'
import type { ProviderOptions } from '../provider/options'
import { hasToolResultMedia } from '../tool/mcpOutput'
import { filesystemWorkspace } from '../tool/sessionFilesystem'
import type { SessionTools, ToolReplay } from '../tool/sessionTools'
import type { createCacheDiagnostics } from './cacheDiagnostics'
import { prepareOperationMessages, prepareStepPrompts } from './enginePrompts'
import {
  type PreparedProviderRequest,
  type StepModel,
  prepareProviderRequest,
  resolveStepModel,
} from './engineRequest'
import {
  type PreparedStepTools,
  type StepContext,
  prepareStepTools,
  publishStepToolContext,
  readStepContext,
} from './engineTools'
import type { ProviderHistorySnapshot } from './historySnapshot'
import type { StreamContext } from './types'

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
  const step = await readStepContext(ctx, execution, windowDeadline)
  if (!step) return null

  const model = resolveStepModel(step.data)
  const tools = await prepareStepTools(step)
  if (!tools) return null

  const prompts = await prepareStepPrompts(
    step,
    tools,
    model.credentials?.model?.label,
  )
  if (!prompts) return null
  if (!(await publishStepToolContext(step, tools))) return null

  const operationMessages = await prepareOperationMessages(step, prompts)
  if (operationMessages === null) return null

  const request = await prepareProviderRequest(step, model, tools, {
    promptItems: prompts.items,
    operationMessages,
    historySnapshot,
  })
  if (!request) return null

  return buildPreparedStep(step, model, tools, request)
}

function buildPreparedStep(
  { data, invokesTools }: StepContext,
  { modelId, contextWindow, trimContext, credentials }: StepModel,
  { names, runtime, replay }: PreparedStepTools,
  request: PreparedProviderRequest,
): PreparedStreamStep {
  return {
    ...request,
    stream: data.stream,
    modelId,
    contextWindow,
    trimContext,
    outputTokens: credentials?.model?.outputTokens,
    agent: data.agent,
    output: data.output,
    workspace:
      invokesTools && hasFilesystemTools(names)
        ? filesystemWorkspace(data.session)
        : data.session.workspace,
    workspaceSessionId: sharedSessionId(data.session),
    isSubagent: !!data.session.parent,
    needsTitle:
      data.stream.command.kind === 'invoke' && !hasSavedTitle(data.session),
    tools: runtime?.tools ?? {},
    // Anthropic keys its message cache on tool choice even for read-only replay.
    toolChoice:
      invokesTools || credentials?.providerId === 'anthropic'
        ? undefined
        : 'none',
    toolRuntime: runtime,
    toolReplay: replay,
    hasActiveMedia: hasToolResultMedia(request.messages),
  }
}
