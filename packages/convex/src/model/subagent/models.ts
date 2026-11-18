import {
  defaultModelReasoning,
  normalizeReasoningEffort,
} from '@cv/core/model-reasoning'

import type { Doc } from '../../_generated/dataModel'
import type { QueryCtx } from '../../_generated/server'
import type { Session } from '../../types'
import type {
  AgentSubagentOverride,
  ModelSelection,
  ReasoningEffort,
} from '../../types'
import {
  effectiveAgentSelection,
  unavailableModelOverride,
} from '../agent/modelOverride'
import {
  findCredentialsForModel,
  findModelSelection,
} from '../provider/providers'
import { resolve as resolveProviders } from '../providers'

export type SubagentModelSettings = {
  model?: ModelSelection
  reasoningEffort?: string
}

export type ResolveSubagentModelArgs = {
  parent: Doc<'agents'> | null
  session: Session
  agent: Doc<'agents'>
}

export type ResolveSubagentModelResult =
  | { settings: SubagentModelSettings; error?: never }
  | { error: string; settings?: never }

/** Resolves spawn-time settings without changing the parent or existing children. */
export async function resolveSubagentModel(
  ctx: QueryCtx,
  { parent, session, agent }: ResolveSubagentModelArgs,
): Promise<ResolveSubagentModelResult> {
  const override = parent?.subAgents?.overrides?.find(
    (entry) => entry.agentId === agent._id,
  )
  const ownOverride = agent.modelOverride
  const parentOverride = parent?.modelOverride
  if (!override && !ownOverride && !parentOverride) {
    return {
      settings: {
        model: session.model,
        reasoningEffort: session.reasoningEffort,
      },
    }
  }

  const pinnedModelId = ownOverride?.modelId ?? override?.modelId
  const providers =
    pinnedModelId || parentOverride
      ? await resolveProviders(ctx, agent.ownerId)
      : []
  if (pinnedModelId && !availableModel(providers, pinnedModelId)) {
    const details = ownOverride
      ? unavailableModelOverride(pinnedModelId)
      : `Model "${pinnedModelId}" is unavailable. Select an enabled model in the parent agent's sub-agent settings.`
    return { error: `Cannot spawn sub-agent "${agent.name}": ${details}` }
  }

  const inherited = inheritedParentSettings(session, providers, parentOverride)
  const model = override?.modelId
    ? (findModelSelection(providers, override.modelId) ?? {
        id: override.modelId,
      })
    : inherited.model

  // Keep the spawn-time selections as fallbacks if the child override is cleared.
  const settings = ownOverride
    ? {
        model,
        reasoningEffort: override?.reasoningEffort ?? inherited.reasoningEffort,
      }
    : resolveReasoning(inherited, model, override)
  return { settings }
}

type Providers = Awaited<ReturnType<typeof resolveProviders>>

function availableModel(providers: Providers, modelId: string) {
  const model = findCredentialsForModel(providers, modelId)?.model
  return model && model.available !== false
}

function inheritedParentSettings(
  session: Session,
  providers: Providers,
  override: Doc<'agents'>['modelOverride'],
): SubagentModelSettings {
  if (!override) return session
  const { modelId, reasoningEffort } = effectiveAgentSelection(
    session,
    override,
  )
  const model = findModelSelection(providers, modelId) ?? {
    id: override.modelId,
  }
  return {
    model,
    reasoningEffort: normalizeReasoningEffort(
      reasoningEffort,
      model.reasoning ?? defaultModelReasoning(),
    ),
  }
}

function resolveReasoning(
  inherited: SubagentModelSettings,
  model: ModelSelection | undefined,
  override?: AgentSubagentOverride,
): SubagentModelSettings {
  // Preserve legacy inheritance exactly when neither setting is overridden.
  if (!override) return { model, reasoningEffort: inherited.reasoningEffort }
  const reasoningEffort = normalizeReasoningEffort(
    override.reasoningEffort ??
      (inherited.reasoningEffort as ReasoningEffort | undefined),
    model?.reasoning ?? defaultModelReasoning(),
  )
  return { model, reasoningEffort }
}
