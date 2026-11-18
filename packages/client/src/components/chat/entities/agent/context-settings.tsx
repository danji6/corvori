import { md } from '@/components/markdown'
import { SettingsList } from '@/components/ui'
import type { Control } from 'react-hook-form'
import { Controller } from 'react-hook-form'

import type { AgentFormValues } from './agent-form'

export function ContextSettings({
  control,
}: {
  control: Control<AgentFormValues>
}) {
  return (
    <SettingsList>
      <Controller
        control={control}
        name="shareUserDisplayNames"
        render={({ field }) => (
          <SettingsList.Switch
            label="Share user display names"
            description="Let this agent see the names of users in the conversation."
            help={md`
              When enabled, user messages are prefixed with the sender's display
              name so this agent can tell different users apart.
            `}
            checked={field.value}
            onCheckedChange={field.onChange}
          />
        )}
      />

      <Controller
        control={control}
        name="shareAgentDisplayNames"
        render={({ field }) => (
          <SettingsList.Switch
            label="Share agent display names"
            description="Let this agent see the names of other agents in the conversation."
            help={md`
              When enabled, messages from other agents are prefixed with their
              display names so this agent can tell them apart.
            `}
            checked={field.value}
            onCheckedChange={field.onChange}
          />
        )}
      />

      <Controller
        control={control}
        name="maskOtherAgents"
        render={({ field }) => (
          <SettingsList.Switch
            label="Mask other agents as users"
            description="Present other agents' messages as user turns."
            help={md`
              When enabled, only this agent's replies are shown as assistant
              turns, while every other agent's messages are masked as user turns.
            `}
            checked={field.value}
            onCheckedChange={field.onChange}
          />
        )}
      />
    </SettingsList>
  )
}
