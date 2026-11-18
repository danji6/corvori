import { usableContextWindow } from '@cv/core/discovered-model'
import { parseModelReference } from '@cv/core/model-reference'
import type {
  AgentModelOverride,
  ReasoningEffort,
  UIModel,
} from '@cv/core/types'

import type { Id } from '../../_generated/dataModel'
import type { QueryCtx } from '../../_generated/server'
import { error } from '../../errors'
import { resolveModelReasoning } from '../provider/known'
import { getSavedModel } from '../provider/providers'

export function unavailableModelOverride(modelId: string) {
  const { modelId: name } = parseModelReference(modelId)
  return `The agent's model override "${name}" is unavailable. Choose an available model in the agent's Behavior settings.`
}

export async function validateModelOverride(
  ctx: QueryCtx,
  ownerId: Id<'users'>,
  override: AgentModelOverride,
) {
  const saved = await getSavedModel(ctx, ownerId, override.modelId)
  if (!saved || saved.model.available === false) {
    error(unavailableModelOverride(override.modelId), 400)
  }
  return { ...override, modelId: saved.id }
}

/** Projects an override for shared session members without provider secrets. */
export async function modelOverrideView(
  ctx: QueryCtx,
  ownerId: Id<'users'>,
  { modelId }: AgentModelOverride,
): Promise<UIModel> {
  const saved = await getSavedModel(ctx, ownerId, modelId)
  if (!saved) return { id: modelId, available: false }
  const { model, providerId } = saved
  return {
    id: modelId,
    label: model.label ?? model.id,
    available: model.available,
    reasoning: resolveModelReasoning(providerId, model.reasoning),
    contextWindow: usableContextWindow(model.contextWindow),
  }
}

type ModelDefaults = {
  model?: { id: string }
  reasoningEffort?: string
}

export function effectiveAgentSelection(
  { model, reasoningEffort }: ModelDefaults,
  override?: AgentModelOverride,
) {
  return {
    modelId: override?.modelId ?? model?.id,
    reasoningEffort:
      override?.reasoningEffort ??
      (reasoningEffort as ReasoningEffort | undefined),
  }
}
