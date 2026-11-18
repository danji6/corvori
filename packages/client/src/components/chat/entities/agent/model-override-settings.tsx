import { SettingsList } from '@/components/ui'
import { useModels } from '@/hooks/chat'
import { findOverrideModel } from '@/hooks/chat/models'
import {
  defaultModelReasoning,
  normalizeReasoningEffort,
} from '@cv/core/model-reasoning'
import { type Control, useController } from 'react-hook-form'

import { ModelPicker } from '../../models/model-picker'
import { ReasoningPicker } from '../../models/reasoning-picker'
import type { AgentFormValues } from './agent-form'
import { OverrideLabel } from './override-section'

export function ModelOverrideSettings({
  control,
}: {
  control: Control<AgentFormValues>
}) {
  const { field } = useController({ control, name: 'modelOverride' })
  const { models, isLoading } = useModels()
  const value = field.value
  const model = findOverrideModel(models, value?.modelId)
  const unavailable = !isLoading && model?.available === false
  const showReasoning =
    value &&
    model &&
    !isLoading &&
    !unavailable &&
    model.reasoning?.type !== 'none'

  function selectModel(modelId: string) {
    if (!modelId) return field.onChange(null)
    const selected = models.find((candidate) => candidate.id === modelId)
    const capability = selected?.reasoning ?? defaultModelReasoning()
    const inherit =
      value?.reasoningEffort === undefined || capability.type === 'none'
    field.onChange({
      modelId,
      reasoningEffort: inherit
        ? undefined
        : normalizeReasoningEffort(value.reasoningEffort, capability),
    })
  }

  return (
    <>
      <SettingsList.Item
        unclickable
        unhoverable
        label={<OverrideLabel>Model</OverrideLabel>}
        description={
          unavailable ? (
            <span className="text-destructive" role="status">
              This model is unavailable. Choose an available model or select
              Inherit.
            </span>
          ) : (
            'Always use the selected model for this agent.'
          )
        }
      >
        <ModelPicker
          className="min-w-32"
          aria-label="Model override"
          inheritLabel="Inherit"
          value={value?.modelId ?? ''}
          selectedModel={model}
          onValueChange={selectModel}
        />
      </SettingsList.Item>
      {showReasoning && (
        <SettingsList.Item
          unclickable
          unhoverable
          label={<OverrideLabel>Reasoning</OverrideLabel>}
        >
          <ReasoningPicker
            className="min-w-32"
            aria-label="Reasoning override"
            model={model}
            value={value.reasoningEffort}
            onInherit={() => field.onChange({ modelId: value.modelId })}
            onValueChange={(reasoningEffort) =>
              field.onChange({ modelId: value.modelId, reasoningEffort })
            }
          />
        </SettingsList.Item>
      )}
    </>
  )
}
