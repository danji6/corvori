import {
  EDIT_FILE_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
} from '@cv/core/const'
import {
  TOOL_DESCRIPTIONS,
  editFileFields,
  fileToolDescription,
  readFileFields,
  writeFileFields,
} from '@cv/core/types'

import { ToolError } from '../../errors'
import { type WorkspaceToolContext, fileWorkspaceArgs } from './context'
import { callMcpTool } from './mcp'
import { fileNeedsApproval } from './paths'

export async function createReadFileTool(context: WorkspaceToolContext) {
  const [{ tool }, { z }] = await Promise.all([import('ai'), import('zod')])
  return tool({
    description: fileToolDescription(
      TOOL_DESCRIPTIONS[READ_FILE_TOOL_NAME],
      context.hasAgentHome ?? !!context.workspace?.agentHome,
      context.workspace?.sessionFiles,
    ),
    inputSchema: z.strictObject(readFileFields),
    needsApproval: ({ path }) =>
      fileNeedsApproval(READ_FILE_TOOL_NAME, path, context),
    execute: async ({ path, offset, limit, byteOffset }) =>
      callMcpTool(READ_FILE_TOOL_NAME, {
        ...(await approvedFileArgs(context)),
        path,
        offset,
        limit,
        byteOffset,
      }),
  })
}

async function assertNotPlanMode(context: WorkspaceToolContext) {
  if (await context.isPlanMode?.()) {
    throw new ToolError(
      'Plan mode is active, you CANNOT modify files. Keep researching and refine the plan.',
    )
  }
}

/** Carries this invocation's passed approval gate without saving a path grant. */
async function approvedFileArgs(context: WorkspaceToolContext) {
  return {
    ...fileWorkspaceArgs(context),
    allowedPaths: (await context.approvals?.())?.paths,
    allowOutsideWorkspace: true,
  }
}

export async function createWriteFileTool(context: WorkspaceToolContext) {
  const [{ tool }, { z }] = await Promise.all([import('ai'), import('zod')])
  return tool({
    description: fileToolDescription(
      TOOL_DESCRIPTIONS[WRITE_FILE_TOOL_NAME],
      context.hasAgentHome ?? !!context.workspace?.agentHome,
      context.workspace?.sessionFiles,
    ),
    inputSchema: z.strictObject(writeFileFields),
    needsApproval: ({ path }) =>
      fileNeedsApproval(WRITE_FILE_TOOL_NAME, path, context),
    execute: async ({ path, content }) => {
      await assertNotPlanMode(context)
      return callMcpTool(WRITE_FILE_TOOL_NAME, {
        ...(await approvedFileArgs(context)),
        path,
        content,
      })
    },
  })
}

export async function createEditFileTool(context: WorkspaceToolContext) {
  const [{ tool }, { z }] = await Promise.all([import('ai'), import('zod')])
  return tool({
    description: fileToolDescription(
      TOOL_DESCRIPTIONS[EDIT_FILE_TOOL_NAME],
      context.hasAgentHome ?? !!context.workspace?.agentHome,
      context.workspace?.sessionFiles,
    ),
    inputSchema: z.strictObject(editFileFields),
    needsApproval: ({ path }) =>
      fileNeedsApproval(EDIT_FILE_TOOL_NAME, path, context),
    execute: async ({ path, edits }) => {
      await assertNotPlanMode(context)
      return callMcpTool(EDIT_FILE_TOOL_NAME, {
        ...(await approvedFileArgs(context)),
        path,
        edits,
      })
    },
  })
}
