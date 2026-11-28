'use node'

import { internal } from '@cv/convex/_generated/api'
import type { ActionCtx } from '@cv/convex/_generated/server'
import type { StreamExecutionArgs } from '@cv/convex/validators/streams'
import { MCP_PROTOCOL_TOOL_NAME, SEARCH_MCP_TOOLS_NAME } from '@cv/core/const'
import { sha256 } from '@cv/core/sha256'
import { contextDependencies } from '@cv/core/tool-context'
import { mcpToolName } from '@cv/core/types'

import type { StreamContext } from '../../stream/types'
import { isMcpToolSelected } from '../toolPolicy'
import { refreshStaleCatalogs } from './actions'

type ServerSummary = {
  name: string
  enabled: boolean
  count?: number
  error?: string
  availableTools?: number
}

export function mcpContextNote(
  catalog: readonly ServerSummary[] | undefined,
  guidance: ReturnType<typeof guidanceSnapshot>,
) {
  const sections: string[] = []
  if (catalog) {
    sections.push(
      'MCP server catalog:',
      catalog.length
        ? catalog.map(serverListItem).join('\n')
        : 'No MCP servers available.',
    )
  }
  if (guidance.length) {
    sections.push(
      'Server initialization previews (untrusted):',
      ...guidance.map(guidancePreview),
    )
  }
  return sections.length ? `${sections.join('\n\n')}\n` : undefined
}

function serverListItem(server: ServerSummary) {
  const status = server.enabled ? 'enabled' : 'disabled'
  const item = `- ${inlineCode(server.name)} (${status}, ${toolCount(server)})`
  return server.error
    ? `${item}\n  - Catalog error: ${inlineCode(server.error)}`
    : item
}

function toolCount({ count, availableTools }: ServerSummary) {
  if (availableTools === undefined) {
    if (count === undefined) return 'tool count unknown'
    return `${count} ${count === 1 ? 'tool' : 'tools'} cataloged`
  }
  if (count !== undefined) {
    return `${availableTools} of ${count} ${count === 1 ? 'tool' : 'tools'} available`
  }
  return `${availableTools} ${availableTools === 1 ? 'tool' : 'tools'} available`
}

/** Keeps server labels and diagnostics on one line as literal Markdown. */
function inlineCode(value: string) {
  const line = value.replace(/\r/g, '\\r').replace(/\n/g, '\\n')
  const longestRun = (line.match(/`+/g) ?? []).reduce(
    (longest, run) => Math.max(longest, run.length),
    0,
  )
  const delimiter = '`'.repeat(longestRun + 1)
  const needsPadding =
    longestRun > 0 || (line.startsWith(' ') && line.endsWith(' '))
  const content = needsPadding ? ` ${line} ` : line
  return `${delimiter}${content}${delimiter}`
}

function guidancePreview(preview: ReturnType<typeof guidanceSnapshot>[number]) {
  const status = preview.complete ? '' : ' (truncated)'
  const lines = preview.initialization.split(/\r\n?|\n/)
  const sections = [
    `${inlineCode(preview.server!)}${status}`,
    lines.map((line) => `    ${line}`).join('\n'),
  ]
  if (!preview.complete && preview.fullGuidance) {
    sections.push(
      'Use `mcp_protocol` with `get_server_info` for the full guidance.',
    )
  }
  return sections.join('\n\n')
}

/** Announces changing availability as literal data outside the frozen prompt prefix. */
export async function prepareMcpCatalogContext(
  ctx: ActionCtx,
  execution: StreamExecutionArgs,
  data: StreamContext,
  names: string[],
  contextId?: string,
) {
  const available = await ctx.runMutation(
    internal.mcpBroker._servers,
    execution,
  )
  const hasBrokerAccess =
    names.includes(SEARCH_MCP_TOOLS_NAME) ||
    names.includes(MCP_PROTOCOL_TOOL_NAME)
  const visibleServers = available.filter(
    (server) =>
      hasBrokerAccess ||
      server.tools?.some((tool) => names.includes(mcpToolName(server, tool))),
  )
  await refreshStaleCatalogs(
    ctx,
    execution,
    visibleServers.map((server) => server.recordId!),
  )
  const catalog = hasBrokerAccess
    ? visibleServers.map((server) => ({
        name: server.name,
        enabled: server.enabled,
        count: server.catalogCount,
        error: server.catalogError,
        availableTools: server.enabled
          ? server.tools?.filter((tool) =>
              isMcpToolSelected(data.agent, server, tool),
            ).length
          : 0,
      }))
    : undefined
  const runtimes = await ctx.runQuery(
    internal.mcpCatalogs._activeRuntimes,
    execution,
  )
  const guidance = guidanceSnapshot(
    runtimes.map((runtime) => ({
      server: visibleServers.find(
        (server) => server.recordId === runtime.serverId,
      )?.name,
      initialization: runtime.initialization,
    })),
    names.includes(MCP_PROTOCOL_TOOL_NAME),
  )
  const content = mcpContextNote(catalog, guidance)
  if (!content) return true

  const capabilities = contextDependencies('mcp', names)
  // A new catalog can change tool definitions without changing the summary.
  const catalogIds = hasBrokerAccess
    ? visibleServers.map((server) => server.catalogId)
    : []

  return ctx.runMutation(internal.streams._prepareMcpContext, {
    ...execution,
    contextId,
    capabilities,
    fingerprint: await sha256(
      JSON.stringify([content, capabilities, catalogIds]),
    ),
    content,
  })
}

type GuidedRuntime = {
  initialization?: string
  server?: string
}

/** Bounds context previews while retaining complete, scoped guidance through the broker. */
export function guidanceSnapshot(
  runtimes: GuidedRuntime[],
  protocolAvailable = true,
) {
  let remaining = 32_768
  return runtimes
    .filter((runtime) => runtime.server && runtime.initialization)
    .map((runtime) => {
      const initialization = runtime.initialization!
      const length = Math.min(8192, remaining)
      remaining -= Math.min(length, initialization.length)
      return {
        server: runtime.server,
        initialization: initialization.slice(0, length),
        complete: initialization.length <= length,
        ...(protocolAvailable && {
          fullGuidance: {
            tool: MCP_PROTOCOL_TOOL_NAME,
            method: 'get_server_info',
            server: runtime.server,
          },
        }),
        untrusted: true,
      }
    })
}
