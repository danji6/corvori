import { formatOutputPage } from '@cv/core/shell/output-page'
import type { ShellToolOutput } from '@cv/core/types/tools'

import type { Doc } from '../../_generated/dataModel'
import type { MutationCtx } from '../../_generated/server'
import {
  SHELL_REPORT_PART_TYPE,
  type ShellReportPart,
  type ShellReportStatus,
} from '../../lib/shellReport'
import { sharedSessionId } from '../../lib/subagent'
import { insertMessage } from '../messageContents'
import { getSessionWithWorkspace } from '../session/folderContext'
import { getActiveStream } from '../session/memberships'
import { reserveInvokeTurn } from '../stream/lifecycle'
import { recordDelivery } from './outputDeliveries'
import { findReference, saveTerminal } from './references'

/** Outcome delivered by a completed watcher window. */
type ShellReportResult = { output?: ShellToolOutput; errorText?: string }

/** Reports stay well under the segment split budget. */
const REPORT_MAX_CHARS = 32 * 1024

/**
 * Delivers a finished job's output to the session that started it as its own
 * `shell-report` message, then wakes the agent if idle.
 */
export async function deliverShellReport(
  ctx: MutationCtx,
  row: Doc<'shellJobs'>,
  { output, errorText }: ShellReportResult,
) {
  const session = await getSessionWithWorkspace(ctx, row.sessionId)
  if (!session) return

  if (output) {
    const sessionId = sharedSessionId(session)
    const origin = await findReference(ctx, { sessionId, jobId: row.jobId })
    if (origin) output = { ...output, jobNumber: origin.number }
    await saveTerminal(ctx, sessionId, output)
  }
  const { messageId } = await insertShellReport(ctx, row, { output, errorText })
  const reportedOutput = errorText ? undefined : output
  if (reportedOutput?.range && !row.userKilled) {
    await recordDelivery(
      ctx,
      {
        sessionId: row.sessionId,
        agentId: row.agentId,
        workspaceId: session.workspace?.workspaceId ?? sharedSessionId(session),
        messageId,
        version: 1,
        partId: 'shell-report',
      },
      reportedOutput,
    )
  }

  // A live turn consumes the report at its end via the follow-up gate
  if (await getActiveStream(ctx, row.sessionId)) return

  // A job the user stopped shouldn't wake the agent
  if (row.userKilled) return

  const message = await ctx.db.get(messageId)
  if (!message) return

  await reserveInvokeTurn(ctx, {
    sessionId: session._id,
    boundaryMessage: message,
    invokedBy: row.invokedBy,
  })
}

function resolveReport(
  output: ShellToolOutput | undefined,
  errorText: string | undefined,
): Pick<ShellReportPart, 'status' | 'text' | 'exitCode'> {
  if (errorText || !output) {
    return {
      status: 'failed',
      text: errorText ?? 'The job produced no result.',
    }
  }

  return {
    status: reportStatus(output),
    text:
      (output.range ? formatOutputPage(output) : truncateReport(output.text)) ||
      '(no output)',
    ...(output.exitCode != null && { exitCode: output.exitCode }),
  }
}

function reportStatus(output: ShellToolOutput): ShellReportStatus {
  return output.status === 'running' || output.status === 'background'
    ? 'failed'
    : output.status
}

function truncateReport(text: string): string {
  if (text.length <= REPORT_MAX_CHARS) return text
  return `${text.slice(0, REPORT_MAX_CHARS)}\n\n[Output truncated.]`
}

/** Inserts an attributed report, retaining the user's stop marker. */
async function insertShellReport(
  ctx: MutationCtx,
  row: Doc<'shellJobs'>,
  { output, errorText }: ShellReportResult,
) {
  const part: ShellReportPart = {
    type: SHELL_REPORT_PART_TYPE,
    jobId: row.jobId,
    command: row.command,
    ...resolveReport(output, errorText),
  }

  // Activity is synced when the woken turn completes
  return insertMessage(
    ctx,
    {
      sessionId: row.sessionId,
      sender: { type: 'agent', id: row.agentId },
      role: 'user', // no 'system' because some providers complain
      status: 'done',
      ...(row.userKilled && { extra: { userKilled: true } }),
    },
    [part],
  )
}
