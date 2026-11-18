import { isFolderCollapsed } from '@/lib/chat/session-folder-state'
import type { SessionTreeNode } from '@/lib/chat/session-groups'
import { api } from '@cv/convex/_generated/api'
import type { Id } from '@cv/convex/_generated/dataModel'
import { SIDEBAR_STREAM_BATCH_SIZE } from '@cv/core/sidebar-streams'
import { type RequestForQueries, useQueries } from 'convex/react'
import { useLayoutEffect, useMemo } from 'react'

import { useSetSidebarStreamingIds } from './sessions'

export function useSidebarStreaming(
  nodes: SessionTreeNode[],
  collapsed: Record<string, boolean>,
  recentsOpen: boolean,
  enabled: boolean,
) {
  const queries = useMemo(() => {
    const queries: RequestForQueries = {}
    if (!enabled) return queries
    const ids = displayedSessionIds(nodes, collapsed, recentsOpen)
    const size = SIDEBAR_STREAM_BATCH_SIZE
    for (let start = 0; start < ids.length; start += size) {
      const sessionIds = ids.slice(start, start + size)
      queries[sessionIds.join(',')] = {
        query: api.streams.activeSessionIdsForSessions,
        args: { sessionIds },
      }
    }
    return queries
  }, [nodes, collapsed, recentsOpen, enabled])

  const results = useQueries(queries)
  const setStreamingIds = useSetSidebarStreamingIds()

  useLayoutEffect(() => {
    const ids = new Set<string>()
    for (const result of Object.values(results)) {
      if (result instanceof Error) throw result
      if (result) {
        for (const id of result as Id<'sessions'>[]) ids.add(id)
      }
    }
    setStreamingIds(ids)
  }, [results, setStreamingIds])
}

function displayedSessionIds(
  nodes: SessionTreeNode[],
  collapsed: Record<string, boolean>,
  recentsOpen: boolean,
) {
  const ids = new Set<string>()
  function visit({ row, children }: SessionTreeNode) {
    if (row.kind === 'session') ids.add(row.id)
    if (row.kind !== 'header') return
    const open =
      row.key === 'recents'
        ? recentsOpen
        : !isFolderCollapsed(collapsed, row.key, row.folderAncestorIds)
    if (open) children.forEach(visit)
  }
  nodes.forEach(visit)
  return [...ids].sort() as Id<'sessions'>[]
}
