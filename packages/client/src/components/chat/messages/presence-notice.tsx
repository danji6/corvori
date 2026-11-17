import { ConfirmDialog, ContextMenu } from '@/components/ui'
import {
  useActiveSession,
  useDeleteMessage,
  useUserProfile,
} from '@/hooks/chat'
import { canMutateMessage, messageExtra } from '@/lib/chat'
import type { MessageRecord } from '@/lib/chat'
import { presenceText } from '@cv/core/presence'
import type { UIMessage } from 'ai'
import { LogInIcon, LogOutIcon, Trash2Icon } from 'lucide-react'
import { useState } from 'react'

import { ContextDivider } from './context-divider'
import {
  useMessageHighlightMenu,
  useMessageHighlightRef,
} from './message-highlight-context'

export type PresenceNoticeProps = {
  message: UIMessage
  record?: MessageRecord
}

/** A divider announcing that a participant joined or left the session. */
export function PresenceNotice({ message, record }: PresenceNoticeProps) {
  const session = useActiveSession()
  const profile = useUserProfile()
  const deleteMessage = useDeleteMessage()
  const [confirm, setConfirm] = useState(false)
  const ref = useMessageHighlightRef(message.id)
  const handleHighlightOpenChange = useMessageHighlightMenu(message.id)
  const canDelete = canMutateMessage(message, record, session, profile)

  const notice = (
    <div
      ref={ref}
      data-slot="presence-notice"
      data-message-id={message.id}
      className="w-full"
    >
      <ContextDivider label={<PresenceLabel record={record} />} />
    </div>
  )

  if (!canDelete) return notice

  return (
    <>
      <ContextMenu onOpenChange={handleHighlightOpenChange}>
        <ContextMenu.Trigger>{notice}</ContextMenu.Trigger>
        <ContextMenu.Content>
          <ContextMenu.Item
            variant="destructive"
            onSelect={() => setConfirm(true)}
          >
            <Trash2Icon />
            Delete
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu>

      <ConfirmDialog
        open={confirm}
        onOpenChange={(open) => !open && setConfirm(false)}
        variant="destructive"
        title="Delete this notice?"
        description="This action cannot be undone."
        confirmText="Delete"
        onConfirm={() => deleteMessage(message.id)}
      />
    </>
  )
}

function PresenceLabel({ record }: { record?: MessageRecord }) {
  const presence = messageExtra(record, 'presence')
  if (!presence) return null

  const Icon = presence.event === 'joined' ? LogInIcon : LogOutIcon
  return (
    <>
      <Icon className="size-3.5 shrink-0" />
      {presenceText(presence.name, presence.event)}
    </>
  )
}
