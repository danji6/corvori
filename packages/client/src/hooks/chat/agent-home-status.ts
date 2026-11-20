import { extractErrorMessage } from '@/lib/errors'
import { api } from '@cv/convex/_generated/api'
import type { Id } from '@cv/convex/_generated/dataModel'
import { useAction } from 'convex/react'
import { useEffect, useState } from 'react'

type Availability = {
  key: string
  exists?: boolean
  path?: string
  error?: string
}

/** Refreshes disk availability on mount, focus, completion and while settings stay open. */
export function useAgentHomeStatus(
  agentId: Id<'agents'> | undefined,
  path: string | undefined,
  revision: number | undefined,
  busy: boolean,
  poll = true,
) {
  const inspect = useAction(api.actions.skills.homeStatus)
  const key = `${agentId}:${path}`
  const [state, setState] = useState<Availability>()

  useEffect(() => {
    if (!agentId || !path || busy) return
    const id = agentId
    let active = true
    let checking = false

    async function refresh() {
      if (checking) return
      checking = true
      try {
        const result = await inspect({ agentId: id })
        if (active) setState({ key, ...result })
      } catch (error) {
        if (active) setState({ key, error: extractErrorMessage(error) })
      } finally {
        checking = false
      }
    }

    void refresh()
    const timer = poll
      ? window.setInterval(() => void refresh(), 10_000)
      : undefined
    window.addEventListener('focus', refresh)

    return () => {
      active = false
      window.clearInterval(timer)
      window.removeEventListener('focus', refresh)
    }
  }, [agentId, path, revision, key, busy, inspect, poll])

  return state?.key === key ? state : undefined
}
