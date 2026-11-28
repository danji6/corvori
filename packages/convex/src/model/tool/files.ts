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
import type { FilesystemCall } from './executionApprovals'
import { approvalsForFilesystemCall } from './filesystemApprovals'
import { callMcpTool, callSidecarMcpTool, sidecarMcpText } from './mcp'
import { fileNeedsApproval } from './paths'
import { readFileOutput, readFileToModelOutput } from './readFileOutput'

export async function createReadFileTool(
  context: WorkspaceToolContext,
  omitMedia?: boolean,
) {
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
    execute: async (input, { toolCallId, abortSignal }) => {
      const args = await approvedFileArgs(context, {
        id: toolCallId,
        name: READ_FILE_TOOL_NAME,
        input,
      })
      const content = await callSidecarMcpTool(
        READ_FILE_TOOL_NAME,
        {
          ...args,
          path: input.path,
          offset: input.offset,
          limit: input.limit,
          byteOffset: input.byteOffset,
        },
        abortSignal,
      )
      return readFileOutput(sidecarMcpText(content), content)
    },
    toModelOutput: ({ output }) => readFileToModelOutput(output, omitMedia),
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
async function approvedFileArgs(
  context: WorkspaceToolContext,
  call: FilesystemCall & { input: { path: string } },
) {
  const approvals = await approvalsForFilesystemCall(context, call, (current) =>
    fileNeedsApproval(call.name, call.input.path, current),
  )
  return {
    ...fileWorkspaceArgs(context),
    allowedPaths: approvals?.paths,
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
    execute: async (input, { toolCallId }) => {
      await assertNotPlanMode(context)
      return callMcpTool(WRITE_FILE_TOOL_NAME, {
        ...(await approvedFileArgs(context, {
          id: toolCallId,
          name: WRITE_FILE_TOOL_NAME,
          input,
        })),
        path: input.path,
        content: input.content,
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
    execute: async (input, { toolCallId }) => {
      await assertNotPlanMode(context)
      return callMcpTool(EDIT_FILE_TOOL_NAME, {
        ...(await approvedFileArgs(context, {
          id: toolCallId,
          name: EDIT_FILE_TOOL_NAME,
          input,
        })),
        path: input.path,
        edits: input.edits,
      })
    },
  })
}
