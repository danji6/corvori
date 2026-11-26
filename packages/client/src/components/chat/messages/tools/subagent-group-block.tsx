import type { ToolUIPart } from 'ai'
import { NetworkIcon } from 'lucide-react'

import { CollapsibleBlock } from '../collapsible-block'
import { SubagentLabel, useSubagentInfo } from './subagent-block'
import { ToolList, ToolListItem } from './tool-list'

/** Renders one or more consecutive `task` calls as a list of sub-agents. */
export function SubagentGroupBlock({
  parts,
  toolErrors,
}: {
  parts: ToolUIPart[]
  messageId: string
  toolErrors?: string[]
}) {
  const label = (
    <>
      Launched{' '}
      <span className="text-foreground font-medium">
        {parts.length} {parts.length === 1 ? 'sub-agent' : 'sub-agents'}
      </span>
    </>
  )

  return (
    <CollapsibleBlock
      data-slot="subagent-group"
      collapsible={false}
      dense
      leadingIcon={<NetworkIcon className="size-3.5 shrink-0" />}
      label={label}
    >
      <ToolList>
        {parts.map((part) => (
          <SubagentGroupItem
            key={part.toolCallId}
            part={part}
            forceError={toolErrors?.includes(part.toolCallId)}
          />
        ))}
      </ToolList>
    </CollapsibleBlock>
  )
}

function SubagentGroupItem({
  part,
  forceError,
}: {
  part: ToolUIPart
  forceError?: boolean
}) {
  const { input, childSessionId, live, status, openSession } = useSubagentInfo(
    part,
    forceError,
  )

  const label = (
    <SubagentLabel
      name={live?.agent?.name ?? input?.agent_name}
      avatarId={live?.agent?.avatarId}
      title={input?.title}
      status={status}
      tokens={live?.tokens ?? null}
      linked={Boolean(childSessionId)}
    />
  )

  return (
    <ToolListItem className="flex">
      {openSession ? (
        <button
          type="button"
          onClick={openSession}
          className="group flex min-w-0 text-left"
        >
          {label}
        </button>
      ) : (
        label
      )}
    </ToolListItem>
  )
}
