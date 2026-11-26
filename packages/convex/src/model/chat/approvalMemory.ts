import {
  CALL_MCP_TOOL_NAME,
  MCP_PROTOCOL_TOOL_NAME,
  SHELL_TOOL_NAME,
} from '@cv/core/const'
import { mcpApprovalKey } from '@cv/core/types/mcp-catalog'
import { mcpProtocolApprovalKey } from '@cv/core/types/mcp-protocol'
import type { RememberScope } from '@cv/core/types/tools'

import { internal } from '../../_generated/api'
import type { AuthMutationCtx } from '../../functions'
import {
  analyzeShellCommand,
  isFileTool,
  toolNamesForApproval,
} from '../../lib/tool/approval'
import { approvalTarget, findName } from '../mcp/brokerNames'
import { _allowToolPaths as allowToolPaths } from '../session/sessions'
import { appendApprovals, getApprovals } from '../session/state'
import type { Session } from '../session/types'

/** The tool call an approval answered. */
export type ApprovedTool = {
  toolName: string
  input: unknown
  /** Sensitive paths resolved when the approval was requested. */
  paths?: string[]
}

export async function rememberApproval(
  ctx: AuthMutationCtx,
  session: Session,
  matched: ApprovedTool,
  scope: RememberScope,
) {
  const approvals = await getApprovals(ctx, session._id)

  if (scope === 'paths') {
    await rememberPaths(ctx, session, matched)
    return
  }

  if (matched.toolName === SHELL_TOOL_NAME) {
    const command = (matched.input as { command?: string } | undefined)?.command
    const additions = command
      ? analyzeShellCommand(command, approvals.shell ?? []).unapproved
      : []
    if (additions.length === 0) return

    await appendApprovals(ctx, session._id, 'shell', additions)
    return
  }

  const tools = approvals.tools ?? []
  const targetKey =
    matched.toolName === CALL_MCP_TOOL_NAME
      ? mcpApprovalKey(await approvalTarget(ctx, session._id, matched.input))
      : matched.toolName === MCP_PROTOCOL_TOOL_NAME
        ? await protocolApproval(ctx, session, matched.input)
        : undefined
  if (matched.toolName === CALL_MCP_TOOL_NAME && !targetKey) return

  if (matched.toolName === MCP_PROTOCOL_TOOL_NAME && !targetKey) return

  const names = targetKey ? [targetKey] : toolNamesForApproval(matched.toolName)
  const additions = names.filter((toolName) => !tools.includes(toolName))
  if (additions.length === 0) return

  await appendApprovals(ctx, session._id, 'tools', additions)
}

async function protocolApproval(
  ctx: AuthMutationCtx,
  session: Session,
  input: unknown,
) {
  const server = (input as { server?: string } | null)?.server
  if (typeof server !== 'string') return
  const binding = await findName(ctx, session._id, 'server', server)
  return binding ? mcpProtocolApprovalKey(input, binding.target) : undefined
}

/** Saves resolved paths or schedules discovery against the current workspace. */
async function rememberPaths(
  ctx: AuthMutationCtx,
  session: Session,
  matched: ApprovedTool,
) {
  const supportsPathGrants =
    matched.toolName === SHELL_TOOL_NAME || isFileTool(matched.toolName)
  if (!supportsPathGrants) return

  if (matched.paths?.length) {
    await allowToolPaths(ctx, {
      sessionId: session._id,
      paths: matched.paths,
    })
    return
  }

  if (matched.toolName !== SHELL_TOOL_NAME || !session.workspace) return
  const command = (matched.input as { command?: string } | undefined)?.command
  if (!command) return

  await ctx.scheduler.runAfter(
    0,
    internal.actions.workspaces._rememberFlaggedPaths,
    {
      sessionId: session._id,
      workspaceId: session.workspace.workspaceId,
      workspace: session.workspace,
      command,
      cwd: (matched.input as { cwd?: string }).cwd,
    },
  )
}
