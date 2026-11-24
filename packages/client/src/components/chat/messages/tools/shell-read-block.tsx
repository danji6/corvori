import { useActiveSessionId } from '@/hooks/chat/session'
import { useToolOutput } from '@/hooks/chat/tool-output'
import { parseOutputValue } from '@/lib/chat/tool-output'
import { api } from '@cv/convex/_generated/api'
import type { Id } from '@cv/convex/_generated/dataModel'
import type { ShellToolOutput } from '@cv/core/types/tools'
import type { ToolUIPart } from 'ai'
import { useQuery } from 'convex/react'

import { useJumpToShell } from '../shell-seek'
import { LoadFullOutput } from './load-full-output'
import { ToolShell } from './tool-shell'

type ShellReadProps = {
  part: ToolUIPart
  messageId: string
  dense?: boolean
  forceError?: boolean
}

export function ShellReadBlock(props: ShellReadProps) {
  const { part } = props
  const sessionId = useActiveSessionId() as Id<'sessions'> | null
  const output = parseOutputValue<ShellToolOutput>(part.output)
  const input = parseOutputValue<{ jobId?: string }>(part.input)
  const jobId = output?.jobId || input?.jobId
  const ref = useQuery(
    api.shellJobs.reference,
    sessionId && jobId && (/^shell-/.test(jobId) || /^[1-9][0-9]*$/.test(jobId))
      ? { sessionId, jobId }
      : 'skip',
  )
  const jump = useJumpToShell()

  const number = output?.jobNumber ?? ref?.number
  const waiting = output?.status === 'running' && output.waitUntil !== undefined
  const label = (
    <>
      {waiting ? 'Waiting for job ' : 'Read output of job '}
      <span className="font-mono">
        {number === undefined ? (jobId ?? '…') : `#${number}`}
      </span>
    </>
  )
  if (!ref) return <SavedShellRead {...props} label={label} />

  return (
    <ToolShell
      {...props}
      data-slot="shell-block"
      className="overflow-visible"
      surface="inset-row"
      fullWidth
      title={part.state === 'output-error' ? part.errorText : undefined}
      onLabelClick={() => jump(ref)}
      noErrorText
      label={label}
    />
  )
}

function SavedShellRead({
  label,
  ...props
}: ShellReadProps & { label: React.ReactNode }) {
  const { output, truncated, loadFull, loadingFull } = useToolOutput(
    props.part,
    props.messageId,
  )
  const saved = parseOutputValue<ShellToolOutput>(output)
  const text = saved
    ? saved.text
    : typeof output === 'string'
      ? output
      : undefined

  return (
    <ToolShell
      {...props}
      data-slot="shell-block"
      className="overflow-visible"
      surface="inset-row"
      fullWidth
      label={label}
    >
      {text && (
        <pre className="bg-m3-surface-container-lowest max-h-72 overflow-auto rounded-(--work-surface-inner-radius) border p-2 font-mono text-xs whitespace-pre-wrap">
          {text}
        </pre>
      )}
      {truncated && <LoadFullOutput onLoad={loadFull} loading={loadingFull} />}
    </ToolShell>
  )
}
