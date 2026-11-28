import { findOverrideModel, useModels } from '@/hooks/chat/models'
import { api } from '@cv/convex/_generated/api'
import type { Doc } from '@cv/convex/_generated/dataModel'
import {
  defaultModelReasoning,
  normalizeReasoningEffort,
} from '@cv/core/model-reasoning'
import { useQuery } from 'convex/react'

export type TaskModelSettings = Pick<
  Doc<'scheduledTasks'>,
  'modelId' | 'reasoningEffort'
>

export function useTaskModelSelection(
  selected: TaskModelSettings | null,
  override?: Doc<'agents'>['modelOverride'],
) {
  const settings = useQuery(api.settings.get, selected ? 'skip' : {})
  const { models, isLoading } = useModels()

  const selection = selected ?? {
    modelId: settings?.recentModel,
    reasoningEffort:
      settings?.recentReasoning as TaskModelSettings['reasoningEffort'],
  }
  const model = findOverrideModel(
    models,
    override?.modelId ?? selection.modelId,
  )
  const capability = model?.reasoning ?? defaultModelReasoning()
  const effort = selection.reasoningEffort
  const reasoningEffort =
    capability.type !== 'none' &&
    normalizeReasoningEffort(effort, capability) === effort
      ? effort
      : undefined

  const modelAvailable = !isLoading && !!model && model.available !== false
  const needsEffort =
    capability.type !== 'none' && override?.reasoningEffort === undefined

  return {
    model,
    value: { modelId: selection.modelId, reasoningEffort },
    isComplete:
      modelAvailable && (!needsEffort || reasoningEffort !== undefined),
  }
}
