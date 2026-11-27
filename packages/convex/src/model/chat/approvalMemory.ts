import {
  CALL_MCP_TOOL_NAME,
  MCP_PROTOCOL_TOOL_NAME,
  SHELL_TOOL_NAME,
} from '@cv/core/const'
import { shellRetry } from '@cv/core/shell/retry'
import { mcpApprovalKey } from '@cv/core/types/mcp-catalog'
import { mcpProtocolApprovalKey } from '@cv/core/types/mcp-protocol'
import type { RememberScope } from '@cv/core/types/tools'

import type { AuthMutationCtx } from '../../functions'
import {
  analyzeShellCommand,
  isFileTool,
  toolNamesForApproval,
} from '../../lib/tool/approval'
import { approvalTarget, findName } from '../mcp/brokerNames'
import { allowToolPaths } from '../session/sessionWorkspace'
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
  if (matched.toolName === SHELL_TOOL_NAME && shellRetry(matched.input)) return
  if (scope === 'paths') {
    await rememberPaths(ctx, session, matched)
    return
  }

  const approvals = await getApprovals(ctx, session._id)

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

/** Saves the verified paths attached to the approval request. */
async function rememberPaths(
  ctx: AuthMutationCtx,
  session: Session,
  matched: ApprovedTool,
) {
  const supportsPathGrants =
    matched.toolName === SHELL_TOOL_NAME || isFileTool(matched.toolName)
  if (!supportsPathGrants || !matched.paths?.length) return

  await allowToolPaths(ctx, {
    sessionId: session._id,
    paths: matched.paths,
  })
}
