import { getToolStatus, hasToolFailed } from '@/lib/chat/parts'
import { cn } from '@/lib/utils'
import { READ_FILE_TOOL_NAME } from '@cv/core/const'
import type { ToolUIPart } from 'ai'

import { CollapsibleBlock } from '../collapsible-block'
import { ToolIcon } from './tool-icon'
import { ToolList, ToolListItem } from './tool-list'
import { ToolShell } from './tool-shell'

type ReadFileInput = {
  path?: string
  offset?: number
  limit?: number
}

/** Renders one or more consecutive read_file calls as a list. */
export function ReadFileBlock({
  parts,
  messageId,
  toolErrors,
}: {
  parts: ToolUIPart[]
  messageId: string
  toolErrors?: string[]
}) {
  const label = (
    <>
      Read{' '}
      <span className="text-foreground font-medium">
        {parts.length} {parts.length === 1 ? 'file' : 'files'}
      </span>
    </>
  )

  return (
    <CollapsibleBlock
      data-slot="read-file-block"
      collapsible={false}
      dense
      leadingIcon={<ToolIcon name={READ_FILE_TOOL_NAME} />}
      label={label}
    >
      <ToolList>
        {parts.map((part) => (
          <ToolListItem key={part.toolCallId}>
            <ReadFileRow
              part={part}
              messageId={messageId}
              forceError={toolErrors?.includes(part.toolCallId)}
            />
          </ToolListItem>
        ))}
      </ToolList>
    </CollapsibleBlock>
  )
}

type ReadFileRowProps = {
  part: ToolUIPart
  messageId: string
  forceError?: boolean
}

function ReadFileRow({ part, messageId, forceError }: ReadFileRowProps) {
  const path = (part.input as ReadFileInput | undefined)?.path
  const failed = hasToolFailed(part, forceError)
  const running = !failed && getToolStatus(part) === 'running'

  const label = (
    <span
      className={cn(
        'chat-tool-list-label font-mono break-all',
        running ? 'text-shimmer' : 'text-foreground',
      )}
    >
      {path?.startsWith('agent://') && 'Personal folder · '}
      {path ?? '…'}
    </span>
  )

  if (!failed) {
    return <div className="flex items-baseline">{label}</div>
  }

  return (
    <ToolShell
      part={part}
      messageId={messageId}
      forceError={forceError}
      leadingIcon={null}
      label={label}
    />
  )
}
