'use node'

import { internal } from '@cv/convex/_generated/api'
import type { ActionCtx } from '@cv/convex/_generated/server'
import type { StreamExecutionArgs } from '@cv/convex/validators/streams'
import { sha256 } from '@cv/core/sha256'
import { contextDependencies } from '@cv/core/tool-context'
import { mcpToolName } from '@cv/core/types'

import type { StreamContext } from '../../stream/types'
import { isMcpToolSelected } from '../toolPolicy'
import { refreshStaleCatalogs } from './actions'

export const mcpContextInstructions = (
  catalog: string,
  names: readonly string[],
) =>
  [
    'Available MCP tools:',
    catalog,
    ...(names.includes('mcp_protocol')
      ? [
          'Use mcp_protocol to read full server initialization instructions, prompts, and resources.',
        ]
      : []),
    ...(names.includes('search_mcp_tools')
      ? ['Use search_mcp_tools to list servers and search their catalogs.']
      : []),
    ...(names.includes('call_mcp_tool')
      ? [
          'Read complete input contracts before calling call_mcp_tool using its discovered name.',
        ]
      : []),
  ].join('\n')

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
  const broker =
    names.includes('search_mcp_tools') || names.includes('mcp_protocol')
  const visibleServers = available.filter(
    (server) =>
      broker ||
      server.tools?.some((tool) => names.includes(mcpToolName(server, tool))),
  )
  await refreshStaleCatalogs(
    ctx,
    execution,
    visibleServers.map((server) => server.recordId!),
  )
  const catalog = visibleServers.map((server) => ({
    name: server.name,
    enabled: server.enabled,
    catalogUpdatedAt: server.catalogUpdatedAt,
    catalogRevision: server.catalogRevision,
    count: server.catalogCount,
    error: server.catalogError,
    availableTools: server.enabled
      ? server.tools?.filter((tool) =>
          isMcpToolSelected(data.agent, server, tool),
        ).length
      : 0,
  }))
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
    names.includes('mcp_protocol'),
  )
  const text = JSON.stringify({ servers: catalog, guidance })

  return ctx.runMutation(internal.streams._prepareMcpContext, {
    ...execution,
    contextId,
    capabilities: contextDependencies('mcp', names),
    fingerprint: await sha256(
      JSON.stringify([text, contextDependencies('mcp', names)]),
    ),
    content: mcpContextInstructions(text, names),
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
            tool: 'mcp_protocol',
            method: 'get_server_info',
            server: runtime.server,
          },
        }),
        untrusted: true,
      }
    })
}
