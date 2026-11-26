import { CHECK_PATHS_TOOL_NAME, READ_FILE_TOOL_NAME } from '@cv/core/const'
import type { PathCheckResult } from '@cv/core/workspace/path-policy'
import { defaultShellDirectory } from '@cv/core/workspace/personal'

import {
  analyzeShellPathCandidates,
  isToolAutoApproved,
  isUnrestrictedAccess,
} from '../../lib/tool/approval'
import type { WorkspaceToolContext } from './context'
import { callMcpTool } from './mcp'

type PathCheckOptions = {
  literal?: boolean
  cwd?: string
  fileLoop?: true
  sessionPaths?: string[]
  shell?: string
}

/** Shared sidecar boundary for file and shell path decisions. */
export async function checkToolPaths(
  paths: string[],
  context: Pick<WorkspaceToolContext, 'sessionId' | 'workspaceId' | 'workspace'>, // prettier-ignore
  allowedPaths: string[] = [],
  options: PathCheckOptions = {},
): Promise<PathCheckResult | null> {
  try {
    const text = await callMcpTool(CHECK_PATHS_TOOL_NAME, {
      sessionId: context.sessionId,
      workspaceId: context.workspaceId,
      workspace: context.workspace,
      paths,
      allowedPaths,
      ...options,
    })
    const result = JSON.parse(text) as PathCheckResult
    if (
      typeof result.complete !== 'boolean' ||
      !Array.isArray(result.resolved) ||
      !Array.isArray(result.uncovered)
    )
      return null
    return result
  } catch {
    return null
  }
}

export async function checkShellToolPaths(
  command: string,
  context: Pick<WorkspaceToolContext, 'sessionId' | 'workspaceId' | 'workspace' | 'shell'>, // prettier-ignore
  allowedPaths: string[] = [],
  cwd = defaultShellDirectory(context.workspace),
): Promise<PathCheckResult | null> {
  const { candidates, complete, fileLoop, sessionPaths } =
    analyzeShellPathCandidates(command)
  if (!complete) return null
  return checkToolPaths(candidates, context, allowedPaths, {
    cwd,
    fileLoop,
    ...(sessionPaths && { sessionPaths, shell: context.shell }),
  })
}

export async function fileNeedsApproval(
  name: string,
  path: string,
  context: WorkspaceToolContext,
): Promise<boolean> {
  const approvals = await context.approvals?.()
  if (isUnrestrictedAccess(approvals)) return false
  const result = await checkToolPaths([path], context, approvals?.paths, {
    literal: true,
  })
  const target = result?.resolved[0]
  if (!result?.complete || !target) return true
  if (target.allowed) return false
  if (target.forbidden || target.outside) return true
  return (
    name !== READ_FILE_TOOL_NAME &&
    !isToolAutoApproved(name, undefined, approvals)
  )
}
