import { SettingsList } from '@/components/ui'
import { EDIT_FILE_TOOL_NAME, WRITE_FILE_TOOL_NAME } from '@cv/core/const'
import { approvalPathsError } from '@cv/core/workspace/path-policy'
import type { Control } from 'react-hook-form'
import { useController } from 'react-hook-form'

import type { AgentFormValues } from './agent-form'
import { PathApprovalList, ShellApprovalList } from './approval-list'

/** Approval-gated tools an agent can be trusted to run unprompted. */
const APPROVAL_GATED_TOOLS = [
  { name: WRITE_FILE_TOOL_NAME, description: 'Create or overwrite files.' },
  { name: EDIT_FILE_TOOL_NAME, description: 'Edit files.' },
]

export function AutoApproveSettings({
  control,
}: {
  control: Control<AgentFormValues>
}) {
  const { field: toolsField } = useController({
    control,
    name: 'autoApproveTools',
  })
  const { field: shellField } = useController({
    control,
    name: 'autoApproveShell',
  })
  const { field: pathsField } = useController({
    control,
    name: 'autoApprovePaths',
  })

  const tools = toolsField.value

  function toggleTool(name: string) {
    toolsField.onChange(
      tools.includes(name)
        ? tools.filter((tool) => tool !== name)
        : [...tools, name],
    )
  }

  return (
    <SettingsList>
      <SettingsList.Item
        label={<span className="font-semibold">Auto approve</span>}
        description="Actions this agent may take without your explicit approval."
        unclickable
        unhoverable
      />
      {APPROVAL_GATED_TOOLS.map((meta) => (
        <SettingsList.Checkbox
          key={meta.name}
          className="pl-8"
          label={meta.name}
          description={meta.description}
          checked={tools.includes(meta.name)}
          onCheckedChange={() => toggleTool(meta.name)}
        />
      ))}
      <ShellApprovalList
        className="pl-8"
        values={shellField.value}
        onChange={shellField.onChange}
        placeholder="git checkout"
      />
      <PathApprovalList
        className="pl-8"
        values={pathsField.value ?? []}
        onChange={pathsField.onChange}
        placeholder="path"
        validate={approvalPathsError}
      />
    </SettingsList>
  )
}
