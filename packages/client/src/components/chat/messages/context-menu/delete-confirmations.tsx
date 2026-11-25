import { ConfirmDialog } from '@/components/ui'
import {
  useDeleteMessage,
  useDeleteMessageAttachment,
  useDeleteMessageParts,
  useDeleteMessagesFrom,
  useHasNewerMessages,
} from '@/hooks/chat'

import type { AttachmentDeletion } from './attachment-deletion'
import type { MenuState } from './message-menu-state'

export type DeleteConfirmation = 'part' | 'message' | AttachmentDeletion

type DeleteConfirmationsProps = {
  open: DeleteConfirmation | null
  onClose: () => void
  messageId: string
  isSpecialMessage: boolean
  deleteState: MenuState['delete']
}

export function DeleteConfirmations({
  open,
  onClose,
  messageId,
  isSpecialMessage,
  deleteState,
}: DeleteConfirmationsProps) {
  const deleteMessage = useDeleteMessage()
  const deleteAttachment = useDeleteMessageAttachment()
  const deleteMessageParts = useDeleteMessageParts()
  const deleteMessagesFrom = useDeleteMessagesFrom()
  const hasNewer = useHasNewerMessages(messageId)
  const { blockFrom, blockAddresses } = deleteState
  const attachment = open && typeof open === 'object' ? open : null

  function handleOpenChange(next: boolean) {
    if (!next) onClose()
  }

  return (
    <>
      {attachment && (
        <ConfirmDialog
          open
          onOpenChange={handleOpenChange}
          variant="destructive"
          title={`Delete attachment?`}
          description={
            attachment.isLastContent
              ? 'This is the only remaining content. Deleting it will also delete the message.'
              : 'This action cannot be undone.'
          }
          confirmText="Delete"
          onConfirm={() => void deleteAttachment(attachment.args)}
        />
      )}
      <ConfirmDialog
        open={open === 'part'}
        onOpenChange={handleOpenChange}
        variant="destructive"
        title="Delete this block?"
        description={
          blockFrom
            ? '"Delete all" also removes every later block in this message. This action cannot be undone.'
            : 'This action cannot be undone.'
        }
        confirmText="Delete"
        extraAction={
          blockFrom
            ? {
                text: 'Delete all',
                variant: 'destructive',
                onConfirm: () => deleteMessageParts(messageId, [], blockFrom),
              }
            : undefined
        }
        onConfirm={() => deleteMessageParts(messageId, blockAddresses)}
      />
      <ConfirmDialog
        open={open === 'message'}
        onOpenChange={handleOpenChange}
        variant="destructive"
        title={isSpecialMessage ? 'Delete this block?' : 'Delete this message?'}
        description={
          hasNewer
            ? '"Delete all" also removes every later message in this session. This action cannot be undone.'
            : 'This action cannot be undone.'
        }
        confirmText="Delete"
        extraAction={
          hasNewer
            ? {
                text: 'Delete all',
                variant: 'destructive',
                onConfirm: () => deleteMessagesFrom(messageId),
              }
            : undefined
        }
        onConfirm={() => deleteMessage(messageId)}
      />
    </>
  )
}
