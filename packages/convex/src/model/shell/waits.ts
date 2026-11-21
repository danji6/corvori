import type { ShellToolOutput } from '@cv/core/types/tools'

import type { Doc } from '../../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../../_generated/server'
import { sharedSessionId } from '../../lib/subagent'
import type { StreamExecutionArgs } from '../../types'
import { getProcessingSegmentRow, patchSegmentParts } from '../messageContents'
import { getSessionWithWorkspace } from '../session/folderContext'
import { ownsExecution } from '../stream/execution'
import { renewStreamLease } from '../stream/lease'
import { register, release } from './jobs'
import { recordToolDeliveries } from './outputDeliveries'
import { findReference, saveTerminal } from './references'

type WaitingPart = {
  type: 'tool-shell' | 'tool-shell_output'
  state: 'output-available'
  toolCallId: string
  input?: { command?: string }
  outputRef?: string
  output: ShellToolOutput & { waitUntil: number }
}

function isWaitingPart(part: unknown): part is WaitingPart {
  const candidate = part as Partial<WaitingPart> | null
  return Boolean(
    (candidate?.type === 'tool-shell' ||
      candidate?.type === 'tool-shell_output') &&
    candidate.state === 'output-available' &&
    candidate.output?.status === 'running' &&
    typeof candidate.output.waitUntil === 'number',
  )
}

export function hasPendingShellWait(row: Doc<'messageContents'> | null) {
  return row?.parts.some(isWaitingPart) ?? false
}

export async function pendingShellWaits(
  ctx: QueryCtx,
  execution: StreamExecutionArgs,
) {
  const stream = await ctx.db.get(execution.streamId)
  if (!ownsExecution(stream, execution)) return null
  const row = await getProcessingSegmentRow(ctx, stream)
  const parts = row?.parts.filter(isWaitingPart) ?? []
  if (!parts.length) return null
  const session = await getSessionWithWorkspace(ctx, stream.sessionId)
  if (!session) return null
  return {
    parts,
    sessionId: sharedSessionId(session),
    owner: session._id,
    workspaceId: session.workspace?.workspaceId ?? sharedSessionId(session),
  }
}

type FinishWait = StreamExecutionArgs & {
  toolCallId: string
  output?: ShellToolOutput
  errorText?: string
}

export async function finishShellWait(ctx: MutationCtx, args: FinishWait) {
  const stream = await ctx.db.get(args.streamId)
  if (!ownsExecution(stream, args)) return false
  const row = await getProcessingSegmentRow(ctx, stream)
  const part = row?.parts.find(
    (part): part is WaitingPart =>
      isWaitingPart(part) && part.toolCallId === args.toolCallId,
  )
  if (!row || !part) return false

  const { output, errorText } = args
  const { output: _previous, outputRef: _ref, ...base } = part
  const settled = output
    ? { ...base, output, preliminary: false }
    : { ...base, state: 'output-error', errorText, preliminary: false }

  await patchSegmentParts(
    ctx,
    row.messageId,
    row,
    row.parts.map((item) => (item === part ? settled : item)),
  )
  await recordToolDeliveries(ctx, stream, row, [settled])
  if (output) await settleWatch(ctx, stream, part, output)
  await renewStreamLease(ctx, stream)
  return true
}

async function settleWatch(
  ctx: MutationCtx,
  stream: Doc<'streams'>,
  part: WaitingPart,
  output: ShellToolOutput,
) {
  const session = await ctx.db.get(stream.sessionId)
  if (!session) return
  const sessionId = sharedSessionId(session)
  if (part.type === 'tool-shell_output')
    await saveTerminal(ctx, sessionId, output)
  if (output.status === 'background') {
    const origin = await findReference(ctx, { sessionId, jobId: output.jobId })
    await register(ctx, {
      sessionId: stream.sessionId,
      agentId: stream.agentId,
      invokedBy: stream.invokedBy,
      jobId: output.jobId,
      command: origin?.command ?? part.input?.command ?? 'Shell job',
      toolCallId: origin?.toolCallId ?? part.toolCallId,
    })
  } else {
    await release(ctx, { sessionId: stream.sessionId, jobId: output.jobId })
  }
}
