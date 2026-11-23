import { useAuthorProfile } from '@/hooks/chat/author-profile'
import type { SessionMember } from '@/lib/chat'
import { capitalize } from '@cv/core/utils/strings'
import { UserIcon } from 'lucide-react'

import { ParticipantRow } from './participant-row'

interface SessionMemberItemProps {
  member: SessionMember
  canRemove: boolean
  canEdit: boolean
  onRemove: () => void
}

export function SessionMemberItem({
  member,
  canRemove,
  canEdit,
  onRemove,
}: SessionMemberItemProps) {
  const { membership } = member
  const sender = { type: 'user' as const, id: membership.userId }
  const profile = useAuthorProfile(sender)
  const name = profile?.name ?? member.name
  return (
    <ParticipantRow
      name={name}
      avatarId={profile?.avatarId ?? member.avatarId}
      editSender={canEdit ? sender : undefined}
      onRemove={canRemove ? onRemove : undefined}
      fallbackIcon={<UserIcon className="size-full" />}
      badge={
        <span className="text-muted-foreground shrink-0 text-xs">
          {capitalize(membership.role)}
        </span>
      }
    />
  )
}
