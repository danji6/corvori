import { Popover, RippleButton } from '@/components/ui'
import { useModels } from '@/hooks/chat'
import { findOverrideModel } from '@/hooks/chat/models'
import type { Doc } from '@cv/convex/_generated/dataModel'
import {
  defaultModelReasoning,
  normalizeReasoningEffort,
} from '@cv/core/model-reasoning'
import { normalizeSubagentOverrides } from '@cv/core/subagent-settings'
import type { AgentSubagentOverride } from '@cv/core/types'
import { Settings2Icon } from 'lucide-react'
import { type Control, useController } from 'react-hook-form'

import { ModelPicker } from '../../models/model-picker'
import { ReasoningPicker } from '../../models/reasoning-picker'
import type { AgentFormValues } from './agent-form'

type SubagentModelPopoverProps = {
  control: Control<AgentFormValues>
  agent: Pick<Doc<'agents'>, '_id' | 'name' | 'modelOverride'>
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** Mounts model controls for the subagent being configured. */
export function SubagentModelPopover({
  control,
  agent,
  open,
  onOpenChange,
}: SubagentModelPopoverProps) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger
        render={<RippleButton type="button" variant="stealth" size="icon-sm" />}
        aria-label={`Configure ${agent.name} model and reasoning`}
      >
        <Settings2Icon className="size-4" />
      </Popover.Trigger>
      <Popover.Content align="end" className="w-60 p-4">
        {open && <SubagentModelFields control={control} agent={agent} />}
      </Popover.Content>
    </Popover>
  )
}

function SubagentModelFields({
  control,
  agent,
}: {
  control: Control<AgentFormValues>
  agent: SubagentModelPopoverProps['agent']
}) {
  const agentId = agent._id
  const { field } = useController({ control, name: 'subAgentOverrides' })
  const overrides = field.value ?? []
  const value = overrides.find((entry) => entry.agentId === agentId)
  const { models, isLoading } = useModels()
  const ownOverride = agent.modelOverride
  const modelId = ownOverride?.modelId ?? value?.modelId
  const model = findOverrideModel(models, modelId)
  const unavailable = !isLoading && model?.available === false
  const reasoningOverridden = ownOverride?.reasoningEffort !== undefined

  function update(patch: Partial<AgentSubagentOverride>) {
    field.onChange(
      normalizeSubagentOverrides([
        ...overrides,
        { ...value, ...patch, agentId },
      ]),
    )
  }

  function setModel(modelId: string) {
    const selected = models.find((entry) => entry.id === modelId)
    update({
      modelId: modelId || undefined,
      reasoningEffort:
        value?.reasoningEffort === undefined || !selected
          ? value?.reasoningEffort
          : normalizeReasoningEffort(
              value.reasoningEffort,
              selected.reasoning ?? defaultModelReasoning(),
            ),
    })
  }

  return (
    <>
      <Popover.Description className="text-xs">
        {ownOverride
          ? 'This subagent will use its own model override.'
          : 'Settings used when this parent agent spawns this subagent.'}
      </Popover.Description>
      <div className="flex flex-col gap-1.5">
        <span>{ownOverride ? 'Model (Overridden)' : 'Model'}</span>
        <ModelPicker
          className="w-full"
          aria-label="Subagent model"
          inheritLabel="Inherit"
          value={modelId ?? ''}
          selectedModel={model}
          disabled={Boolean(ownOverride)}
          onValueChange={setModel}
        />
        {unavailable && (
          <p className="text-destructive text-sm" role="status">
            {ownOverride
              ? 'This model is unavailable. Edit the subagent’s model override in its Behavior settings.'
              : 'This model is unavailable. Choose another model before spawning this agent.'}
          </p>
        )}
      </div>
      {(!ownOverride || model?.reasoning?.type !== 'none') && (
        <div className="flex flex-col gap-1.5">
          <span>
            {reasoningOverridden ? 'Reasoning (Overridden)' : 'Reasoning'}
          </span>
          <ReasoningPicker
            className="w-full"
            aria-label="Subagent reasoning"
            value={ownOverride?.reasoningEffort ?? value?.reasoningEffort}
            model={model?.available === false ? null : model}
            disabled={reasoningOverridden}
            onInherit={() => update({ reasoningEffort: undefined })}
            onValueChange={(reasoningEffort) => update({ reasoningEffort })}
          />
        </div>
      )}
    </>
  )
}
