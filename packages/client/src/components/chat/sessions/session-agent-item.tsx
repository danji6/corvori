import type { LinkedAgent } from '@/hooks/chat'
import { useAuthorProfile } from '@/hooks/chat/author-profile'

import { ParticipantRow } from './participant-row'

interface SessionAgentItemProps {
  agent: LinkedAgent
  isActive: boolean
  canEdit: boolean
  canUnlink: boolean
  onActivate: () => void
  onUnlink: () => void
}

export function SessionAgentItem({
  agent,
  isActive,
  canEdit,
  canUnlink,
  onActivate,
  onUnlink,
}: SessionAgentItemProps) {
  const sender = { type: 'agent' as const, id: agent._id }
  const profile = useAuthorProfile(sender)
  const name = profile?.name ?? agent.name
  return (
    <ParticipantRow
      name={name}
      avatarId={profile ? profile.avatarId : agent.avatarId}
      editSender={canEdit ? sender : undefined}
      onRemove={canUnlink ? onUnlink : undefined}
      active={isActive}
      onClick={onActivate}
      badge={
        isActive && (
          <span className="text-secondary shrink-0 text-xs font-semibold">
            Active
          </span>
        )
      }
    />
  )
}
