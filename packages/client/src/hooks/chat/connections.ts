import { api } from '@cv/convex/_generated/api'
import type { McpServerView } from '@cv/convex/model/mcp/servers'
import type { ModelProviderView } from '@cv/convex/model/provider/connections'
import { useQuery } from 'convex-helpers/react/cache/hooks'
import { useAction, useMutation } from 'convex/react'

export function useMcpServers(): McpServerView[] | undefined {
  return useQuery(api.mcp.list, {})
}

export function useMcpServersSave() {
  return useMutation(api.mcp.replaceAll)
}

export function useModelProviders(): ModelProviderView[] | undefined {
  return useQuery(api.providers.list, {})
}

/** Reads a server's tools without storing them. */
export function useMcpToolDiscovery() {
  return useAction(api.actions.mcp.discoverMcpTools)
}
