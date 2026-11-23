import { api } from '@cv/convex/_generated/api'
import type { Id } from '@cv/convex/_generated/dataModel'
import type { MessageSender } from '@cv/convex/validators/messages'
import { toOptionalName } from '@cv/core/utils/names'
import { useQuery } from 'convex/react'

import { useActiveSessionId } from './session'
import { useSettings } from './settings'

/** Subscribes by author, independently of the transcript's retained pages. */
export function useAuthorProfile(sender?: MessageSender) {
  const sessionId = useActiveSessionId() as Id<'sessions'> | null
  return useQuery(
    api.sessions.authorProfile,
    sessionId && sender ? { sessionId, sender } : 'skip',
  )
}

export function useParticipantNames(
  userId: Id<'users'> | undefined,
  agent: { _id: Id<'agents'>; name: string } | null,
) {
  const settings = useSettings()
  const user = useAuthorProfile(
    userId ? { type: 'user', id: userId } : undefined,
  )
  const assistant = useAuthorProfile(
    agent ? { type: 'agent', id: agent._id } : undefined,
  )
  return {
    user: user?.name ?? toOptionalName(settings?.displayName),
    assistant: assistant?.name ?? agent?.name,
  }
}
