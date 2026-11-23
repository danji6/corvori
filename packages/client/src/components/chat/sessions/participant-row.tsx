import { DropdownMenu, RippleButton } from '@/components/ui'
import { useActiveSession } from '@/hooks/chat/session'
import { cn } from '@/lib/utils'
import type { Id } from '@cv/convex/_generated/dataModel'
import type { MessageSender } from '@cv/convex/validators/messages'
import { EllipsisIcon, PencilIcon, XIcon } from 'lucide-react'
import { type ReactNode, useState } from 'react'

import { EditSessionProfile } from './edit-session-profile'
import { SessionAvatar } from './session-avatar'

interface ParticipantRowProps {
  name: string
  avatarId?: Id<'avatars'>
  fallbackIcon?: ReactNode
  active?: boolean
  badge?: ReactNode
  editSender?: MessageSender
  onRemove?: () => void
  onClick?: () => void
}

export function ParticipantRow({
  name,
  avatarId,
  fallbackIcon,
  active,
  badge,
  editSender,
  onRemove,
  onClick,
}: ParticipantRowProps) {
  const hasActions = Boolean(editSender || onRemove)

  return (
    <div className="relative w-full">
      <RippleButton
        variant="stealth"
        className={cn(
          'h-auto w-full justify-start gap-2.5 rounded-full py-1.5 pl-2',
          hasActions ? 'pr-10' : 'pr-4',
          active && 'bg-m3-surface-container-high',
        )}
        onClick={onClick}
      >
        <SessionAvatar
          avatarId={avatarId}
          fallbackIcon={fallbackIcon}
          size="sm"
        />
        <span className="min-w-0 flex-1 truncate text-start">{name}</span>
        {badge}
      </RippleButton>

      {hasActions && (
        <ParticipantActions
          name={name}
          editSender={editSender}
          onRemove={onRemove}
        />
      )}
    </div>
  )
}

type ParticipantActionsProps = Pick<
  ParticipantRowProps,
  'name' | 'editSender' | 'onRemove'
>

function ParticipantActions({
  name,
  editSender,
  onRemove,
}: ParticipantActionsProps) {
  const session = useActiveSession()
  const [editingSession, setEditingSession] = useState<Id<'sessions'>>()

  return (
    <>
      <DropdownMenu>
        <DropdownMenu.Trigger
          render={
            <RippleButton
              size="icon"
              variant="stealth"
              aria-label={`Options for ${name}`}
              className="absolute top-1/2 right-1 size-7 -translate-y-1/2"
            >
              <EllipsisIcon />
            </RippleButton>
          }
        />
        <DropdownMenu.Content align="end">
          {editSender && (
            <DropdownMenu.Item onClick={() => setEditingSession(session?._id)}>
              <PencilIcon />
              Edit...
            </DropdownMenu.Item>
          )}
          {onRemove && (
            <DropdownMenu.Item variant="destructive" onClick={onRemove}>
              <XIcon />
              Remove
            </DropdownMenu.Item>
          )}
        </DropdownMenu.Content>
      </DropdownMenu>
      {editSender && session && editingSession === session._id && (
        <EditSessionProfile
          target={{ sessionId: session._id, sender: editSender }}
          onClose={() => setEditingSession(undefined)}
        />
      )}
    </>
  )
}
