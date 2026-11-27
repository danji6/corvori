import { ModelPicker } from '@/components/chat/models/model-picker'
import { ReasoningPicker } from '@/components/chat/models/reasoning-picker'
import type { UIModel } from '@/lib/chat'
import type { Doc } from '@cv/convex/_generated/dataModel'
import { useId } from 'react'

import { fieldStyle } from './task-schedule-fields'

export type TaskModelSettings = Pick<
  Doc<'scheduledTasks'>,
  'modelId' | 'reasoningEffort'
>

type TaskModelFieldsProps = {
  override?: Doc<'agents'>['modelOverride']
  model: UIModel | null
  value: TaskModelSettings
  onChange: (value: TaskModelSettings) => void
}

export function TaskModelFields({
  override,
  model,
  value,
  onChange,
}: TaskModelFieldsProps) {
  const modelFieldId = useId()
  const reasoningFieldId = useId()
  const fixedEffort = override?.reasoningEffort
  const canChooseEffort =
    !!model && model.available !== false && model.reasoning?.type !== 'none'

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className={fieldStyle}>
        <label htmlFor={modelFieldId}>
          Model{' '}
          {override && (
            <span className="text-muted-foreground">(set by agent)</span>
          )}
        </label>
        <ModelPicker
          id={modelFieldId}
          className="h-11 w-full"
          aria-required={!override}
          disabled={!!override}
          value={model?.id ?? ''}
          selectedModel={model}
          onValueChange={(modelId) => onChange({ ...value, modelId })}
        />
      </div>
      <div className={fieldStyle}>
        <label htmlFor={reasoningFieldId}>
          Reasoning effort{' '}
          {fixedEffort !== undefined && (
            <span className="text-muted-foreground">(set by agent)</span>
          )}
        </label>
        <ReasoningPicker
          id={reasoningFieldId}
          className="h-11 w-full"
          aria-label="Reasoning effort"
          aria-required={canChooseEffort && fixedEffort === undefined}
          model={model}
          placeholder={
            model?.reasoning?.type === 'none'
              ? 'Not applicable'
              : 'Select effort…'
          }
          disabled={!canChooseEffort || fixedEffort !== undefined}
          value={fixedEffort ?? value.reasoningEffort}
          onValueChange={(reasoningEffort) =>
            onChange({ ...value, reasoningEffort })
          }
        />
      </div>
    </div>
  )
}
