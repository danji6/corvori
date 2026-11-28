import { stableStringify } from '@cv/core/stable-json'
import type { ToolApprovals } from '@cv/core/types/tools'

import type { Doc } from '../../_generated/dataModel'
import type { QueryCtx } from '../../_generated/server'
import { error } from '../../errors'
import { minRole } from '../../lib/roles'
import { mergeToolApprovals } from '../../lib/tool/approval'
import type { StreamExecutionArgs } from '../../validators/streams'
import { getProcessingSegmentRow } from '../messageContents'
import { getSessionWithWorkspace, workspaceKey } from '../session/folderContext'
import { getApprovals } from '../session/state'
import { ownsExecution } from '../stream/execution'

export type ExecutionApprovals = {
  approvals?: ToolApprovals
  taskApprovalRevision?: number
  manuallyApproved?: boolean
}

export type FilesystemCall = { id: string; name: string; input: unknown }

async function activeTaskPolicy(ctx: QueryCtx, stream: Doc<'streams'>) {
  if (!stream.taskRunId) return
  const run = await ctx.db.get(stream.taskRunId)
  if (run?.status !== 'running' || run.approvalRevision === undefined) {
    return
  }
  if (run.sessionId !== stream.sessionId || run.agentId !== stream.agentId) {
    return
  }

  const task = await ctx.db.get(run.taskId)
  if (!task?.approvals || task.state === 'archived') {
    return
  }
  if (
    task.activeRunId !== run._id ||
    task.approvalRevision !== run.approvalRevision
  ) {
    return
  }
  if (task.ownerId !== stream.invokedBy || task.agentId !== stream.agentId) {
    return
  }

  const [session, invoker] = await Promise.all([
    getSessionWithWorkspace(ctx, stream.sessionId),
    ctx.db.get(stream.invokedBy),
  ])
  if (!session || session.parent || !minRole(invoker?.role, 'admin')) {
    return
  }
  if (
    session.ownerId !== task.ownerId ||
    session.activeAgentId !== task.agentId
  ) {
    return
  }
  if (session.scheduledTaskId !== task._id || session.taskRunId !== run._id) {
    return
  }
  if (
    session.folderId !== task.folderId ||
    task.approvalWorkspaceKey !== workspaceKey(session.workspace)
  ) {
    return
  }

  return { grants: task.approvals, revision: run.approvalRevision }
}

async function hasManualApproval(
  ctx: QueryCtx,
  stream: Doc<'streams'>,
  call: FilesystemCall,
) {
  const row = await getProcessingSegmentRow(ctx, stream)
  return (
    row?.parts.some((part) => {
      const saved = part as {
        type?: string
        input?: unknown
        toolCallId?: string
        state?: string
        approval?: { approved?: boolean }
      }
      return (
        saved?.toolCallId === call.id &&
        saved.type === `tool-${call.name}` &&
        saved.state === 'approval-responded' &&
        saved.approval?.approved === true &&
        stableStringify(saved.input) === stableStringify(call.input)
      )
    }) ?? false
  )
}

/** Resolves the approval policy for the live invocation, including run-only grants. */
export async function executionApprovals(
  ctx: QueryCtx,
  args: StreamExecutionArgs & { call?: FilesystemCall },
): Promise<ExecutionApprovals> {
  const stream = await ctx.db.get(args.streamId)
  if (!ownsExecution(stream, args))
    error('Tool invocation is no longer active', 409)

  const [session, agent, task] = await Promise.all([
    getApprovals(ctx, stream.sessionId),
    ctx.db.get(stream.agentId),
    activeTaskPolicy(ctx, stream),
  ])
  const policy = agent?.ownerId === stream.invokedBy ? task : undefined

  return {
    approvals: mergeToolApprovals(
      mergeToolApprovals(session, agent?.autoApprove),
      policy?.grants,
    ),
    taskApprovalRevision: policy?.revision,
    manuallyApproved: args.call
      ? await hasManualApproval(ctx, stream, args.call)
      : undefined,
  }
}
