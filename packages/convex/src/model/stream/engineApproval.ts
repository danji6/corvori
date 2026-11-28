'use node'

import {
  EDIT_FILE_TOOL_PART_TYPE,
  SHELL_TOOL_PART_TYPE,
  WRITE_FILE_TOOL_PART_TYPE,
} from '@cv/core/const'
import { shellRetry } from '@cv/core/shell/retry'
import type { FolderWorkspace } from '@cv/core/types/workspace'
import {
  type PathCheckResult,
  pathApprovalStatus,
} from '@cv/core/workspace/path-policy'
import type { UIMessage } from 'ai'

import { internal } from '../../_generated/api'
import type { Id } from '../../_generated/dataModel'
import type { ActionCtx } from '../../_generated/server'
import { isFileTool, mergeToolApprovals } from '../../lib/tool/approval'
import { postSidecar } from '../sidecar'
import { checkShellToolPaths, checkToolPaths } from '../tool/paths'
import { type prepare } from './engineSetup'

export function hasAwaitingApproval(parts: UIMessage['parts']) {
  return parts.some((part) => {
    if (!part.type.startsWith('tool-')) return false
    const toolPart = part as { state?: string }
    return toolPart.state === 'approval-requested'
  })
}

export const FILE_MUTATION_TOOL_TYPES = new Set<string>([
  WRITE_FILE_TOOL_PART_TYPE,
  EDIT_FILE_TOOL_PART_TYPE,
])

export type ApprovalContext = {
  sessionId: Id<'sessions'>
  workspaceId: string
  workspace?: FolderWorkspace
  shell?: string
  allowedPaths?: string[]
}

/**
 * Attach what an approval request needs beyond its input: a simulated diff for
 * file mutations, and resolved paths for file and shell access.
 */
export async function attachApprovalPreviews(
  ctx: ActionCtx,
  setup: NonNullable<Awaited<ReturnType<typeof prepare>>>,
  parts: UIMessage['parts'],
): Promise<UIMessage['parts']> {
  const workspaceId = setup.workspace?.workspaceId
  if (!workspaceId) return parts

  const context = {
    sessionId: setup.workspaceSessionId,
    workspaceId,
    workspace: setup.workspace,
    shell: setup.toolRuntime?.current.shell,
    allowedPaths: await previewPaths(ctx, setup),
  }
  const result = await Promise.all(
    parts.map((part) => withApprovalPreview(context, part)),
  )

  return result as UIMessage['parts']
}

async function previewPaths(
  ctx: ActionCtx,
  { stream, agent }: NonNullable<Awaited<ReturnType<typeof prepare>>>,
) {
  if (stream.taskRunId) {
    const { approvals } = await ctx.runQuery(
      internal.streams._getExecutionApprovals,
      {
        streamId: stream._id,
        generation: stream.generation,
      },
    )
    return approvals?.paths
  }
  const approvals = await ctx.runQuery(internal.sessions._getApprovals, {
    sessionId: stream.sessionId,
  })
  return mergeToolApprovals(approvals ?? undefined, agent.autoApprove)?.paths
}

async function withApprovalPreview(
  context: ApprovalContext,
  part: UIMessage['parts'][number],
) {
  if ((part as { state?: string }).state !== 'approval-requested') {
    return part
  }
  if (isFileTool(part.type.replace(/^tool-/, ''))) {
    const checked = await withFileApprovalPaths(context, part)
    return FILE_MUTATION_TOOL_TYPES.has(part.type)
      ? withPreviewDiff(context, checked)
      : checked
  }
  return part.type === SHELL_TOOL_PART_TYPE
    ? withApprovalPaths(context, part)
    : part
}

async function withFileApprovalPaths(
  context: ApprovalContext,
  part: UIMessage['parts'][number],
) {
  const input = (part as { input?: { path?: string } }).input
  if (typeof input?.path !== 'string') return part
  const result = await checkToolPaths(
    [input.path],
    context,
    context.allowedPaths,
    { literal: true },
  )
  return withPathApprovalResult(part, result)
}

type PreviewDiffInput = {
  path?: string
  content?: string
  edits?: unknown
}

export async function withPreviewDiff(
  context: ApprovalContext,
  part: UIMessage['parts'][number],
) {
  const input = (part as { input?: PreviewDiffInput }).input
  if (!input?.path) return part

  try {
    const { diff, path } = await postSidecar<{ diff: string; path?: string }>(
      '/workspace/preview-diff',
      {
        ...context,
        filePath: input.path,
        content: input.content,
        edits: input.edits,
      },
    )
    if (!diff) return part
    return { ...part, previewDiff: diff, previewPath: path }
  } catch {
    return part
  }
}

export async function withApprovalPaths(
  context: ApprovalContext,
  part: UIMessage['parts'][number],
) {
  const input = (part as { input?: { command?: string; cwd?: string } }).input
  if (shellRetry(input)) return part
  const command = input?.command
  if (typeof command !== 'string') return part

  const result = await checkShellToolPaths(
    command,
    context,
    context.allowedPaths,
    input?.cwd,
  )

  return withPathApprovalResult(part, result)
}

function withPathApprovalResult(
  part: UIMessage['parts'][number],
  result: PathCheckResult | null,
) {
  return {
    ...part,
    approvalPathStatus: pathApprovalStatus(result),
    ...(result?.complete && result.uncovered.length
      ? { approvalPaths: result.uncovered }
      : {}),
  }
}
