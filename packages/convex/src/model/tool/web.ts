import { WEB_FETCH_TOOL_NAME, WEB_SEARCH_TOOL_NAME } from '@cv/core/const'
import {
  TOOL_DESCRIPTIONS,
  webFetchQuerySchema,
  webSearchQuerySchema,
} from '@cv/core/types'

import { ToolError } from '../../errors'
import { callMcpTool } from './mcp'
import { type WebToolSettings, normalizeWebSearchInstances } from './settings'

export async function createWebFetchTool() {
  const { tool } = await import('ai')
  return tool({
    description: TOOL_DESCRIPTIONS[WEB_FETCH_TOOL_NAME],
    inputSchema: webFetchQuerySchema,
    execute: (input, { abortSignal }) =>
      callMcpTool(WEB_FETCH_TOOL_NAME, input, abortSignal),
  })
}

export async function createWebSearchTool(settings?: WebToolSettings) {
  const { tool } = await import('ai')
  return tool({
    description: TOOL_DESCRIPTIONS[WEB_SEARCH_TOOL_NAME],
    inputSchema: webSearchQuerySchema,
    execute: (input, { abortSignal }) => {
      const instances = normalizeWebSearchInstances(
        settings?.webSearchInstances,
      )
      if (instances.length === 0) {
        throw new ToolError('Web search is not configured.')
      }
      return callMcpTool(
        WEB_SEARCH_TOOL_NAME,
        { ...input, instances },
        abortSignal,
      )
    },
  })
}
