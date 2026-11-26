import { api } from '@cv/convex/_generated/api'
import { minRole } from '@cv/convex/lib/roles'
import { SHELL_TOOL_NAME } from '@cv/core/const'
import { useQuery } from 'convex/react'

import { useUserProfile } from './profile'

export function useTools() {
  const tools = useQuery(api.tools.list)
  return {
    tools: tools ?? [],
    isLoading: tools === undefined,
  }
}

export function useIsWorkspaceAdmin(): boolean {
  const { tools } = useTools()
  return tools.some((tool) => tool.name === SHELL_TOOL_NAME)
}

export function useIsAdmin(): boolean {
  const profile = useUserProfile()
  return minRole(profile?.role, 'admin')
}
