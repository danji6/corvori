import {
  CHECK_PATHS_TOOL_NAME,
  EDIT_FILE_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  SHELL_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
} from '@cv/core/const'
import {
  TOOL_DESCRIPTIONS,
  webFetchQuerySchema,
  webSearchSchema,
} from '@cv/core/types'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { Context } from 'hono'
import { z } from 'zod'

import { fetchWeb } from './fetch/web_fetch'
import {
  checkPathsFields,
  editFileFields,
  readFileFields,
  shellFields,
  writeFileFields,
} from './tool-fields'
import { searchWeb } from './web_search'
import {
  checkFlaggedPaths,
  editWorkspaceFile,
  readWorkspaceFile,
  runWorkspaceCommand,
  writeWorkspaceFile,
} from './workspace/workspace'

export async function handleMcpRequest(c: Context): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })
  const server = buildMcpServer()

  try {
    await server.connect(transport)
    return await transport.handleRequest(c.req.raw)
  } catch (err: unknown) {
    console.error('Error handling MCP request:', err)
    return c.json(
      {
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: 'Internal server error',
        },
        id: null,
      },
      500,
    )
  } finally {
    await transport.close()
    await server.close()
  }
}

function buildMcpServer(): McpServer {
  const server = new McpServer({ name: 'chat-tools', version: '1.0.0' })

  server.registerTool(
    WEB_FETCH_TOOL_NAME,
    {
      description: TOOL_DESCRIPTIONS[WEB_FETCH_TOOL_NAME],
      inputSchema: webFetchQuerySchema.shape,
    },
    async (input, { signal }) => {
      const result = await fetchWeb(input, signal)
      return { content: [{ type: 'text' as const, text: formatJson(result) }] }
    },
  )

  server.registerTool(
    WEB_SEARCH_TOOL_NAME,
    {
      description: TOOL_DESCRIPTIONS[WEB_SEARCH_TOOL_NAME],
      inputSchema: webSearchSchema.shape,
    },
    async (input, { signal }) => {
      const result = await searchWeb(input, signal)
      return { content: [{ type: 'text' as const, text: formatJson(result) }] }
    },
  )

  server.registerTool(
    READ_FILE_TOOL_NAME,
    {
      description: TOOL_DESCRIPTIONS[READ_FILE_TOOL_NAME],
      inputSchema: z.strictObject(readFileFields),
    },
    async ({
      sessionId,
      workspaceId,
      workspace,
      path,
      offset,
      limit,
      byteOffset,
      allowedPaths,
      allowOutsideWorkspace,
    }) => {
      const result = await readWorkspaceFile({
        sessionId,
        workspaceId,
        workspace,
        filePath: path,
        allowedPaths,
        allowOutsideWorkspace,
        offset,
        limit,
        byteOffset,
      })
      return { content: [{ type: 'text' as const, text: formatJson(result) }] }
    },
  )

  server.registerTool(
    WRITE_FILE_TOOL_NAME,
    {
      description: TOOL_DESCRIPTIONS[WRITE_FILE_TOOL_NAME],
      inputSchema: z.strictObject(writeFileFields),
    },
    async ({
      sessionId,
      workspaceId,
      workspace,
      path,
      content,
      allowedPaths,
      allowOutsideWorkspace,
    }) => {
      const result = await writeWorkspaceFile({
        sessionId,
        workspaceId,
        workspace,
        filePath: path,
        allowedPaths,
        allowOutsideWorkspace,
        content,
      })
      return { content: [{ type: 'text' as const, text: formatJson(result) }] }
    },
  )

  server.registerTool(
    EDIT_FILE_TOOL_NAME,
    {
      description: TOOL_DESCRIPTIONS[EDIT_FILE_TOOL_NAME],
      inputSchema: z.strictObject(editFileFields),
    },
    async ({
      sessionId,
      workspaceId,
      workspace,
      path,
      edits,
      allowedPaths,
      allowOutsideWorkspace,
    }) => {
      const result = await editWorkspaceFile({
        sessionId,
        workspaceId,
        workspace,
        filePath: path,
        allowedPaths,
        allowOutsideWorkspace,
        edits,
      })
      return { content: [{ type: 'text' as const, text: formatJson(result) }] }
    },
  )

  server.registerTool(
    SHELL_TOOL_NAME,
    {
      description:
        'Run a (bash) shell command in the configured session workspace and return stdout/stderr.',
      inputSchema: z.strictObject(shellFields),
    },
    async ({
      sessionId,
      workspaceId,
      workspace,
      command,
      cwd,
      allowedPaths,
      timeout,
    }) => {
      const result = await runWorkspaceCommand({
        sessionId,
        workspaceId,
        workspace,
        command,
        cwd,
        allowedPaths,
        timeout,
      })
      return { content: [{ type: 'text' as const, text: result.output }] }
    },
  )

  server.registerTool(
    CHECK_PATHS_TOOL_NAME,
    {
      description:
        'Report which of the given paths are sensitive (git-ignored or outside the workspace). Globs are expanded.',
      inputSchema: z.strictObject(checkPathsFields),
    },
    async ({
      sessionId,
      workspaceId,
      workspace,
      paths,
      allowedPaths,
      literal,
      fileLoop,
      sessionPaths,
      shell,
      cwd,
    }) => {
      const result = await checkFlaggedPaths({
        sessionId,
        workspaceId,
        workspace,
        paths,
        allowedPaths,
        literal,
        fileLoop,
        sessionPaths,
        shell,
        cwd,
      })
      return { content: [{ type: 'text' as const, text: formatJson(result) }] }
    },
  )

  return server
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2)
}
