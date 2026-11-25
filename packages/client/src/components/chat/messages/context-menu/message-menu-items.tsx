import { ContextMenu } from '@/components/ui'
import { writeClipboardText } from '@/lib/clipboard'
import { toastError } from '@/lib/notifications'
import { CopyIcon, PencilIcon, Trash2Icon } from 'lucide-react'

import type { MenuState } from './message-menu-state'

function copy(text: string) {
  void writeClipboardText(text).catch((error) =>
    toastError(error, 'Failed to copy message'),
  )
}

type EditMenuProps = {
  edit: MenuState['edit']
  onEditBlock: () => void
  onEditMessage: () => void
}

export function EditMenu({ edit, onEditBlock, onEditMessage }: EditMenuProps) {
  if (edit.submenu) {
    return (
      <ContextMenu.Sub>
        <ContextMenu.SubTrigger>
          <PencilIcon />
          Edit
        </ContextMenu.SubTrigger>
        <ContextMenu.SubContent>
          {edit.block && (
            <ContextMenu.Item onSelect={onEditBlock}>
              <PencilIcon />
              Edit Block
            </ContextMenu.Item>
          )}
          {edit.messageText && (
            <ContextMenu.Item onSelect={onEditMessage}>
              <PencilIcon />
              Edit Message
            </ContextMenu.Item>
          )}
        </ContextMenu.SubContent>
      </ContextMenu.Sub>
    )
  }

  if (!edit.messageText) return null

  return (
    <ContextMenu.Item onSelect={onEditMessage}>
      <PencilIcon />
      Edit Message
    </ContextMenu.Item>
  )
}

type CopyMenuProps = MenuState['copy'] & {
  hasSelection: boolean
}

export function CopyMenu({
  blockText,
  messageText,
  hasSelection,
}: CopyMenuProps) {
  const copyMessage = messageText ? (
    <ContextMenu.Item onSelect={() => copy(messageText)}>
      <CopyIcon />
      {hasSelection ? 'Copy Selection' : 'Copy Message'}
    </ContextMenu.Item>
  ) : null
  const copyBlock =
    blockText !== undefined ? (
      <ContextMenu.Item onSelect={() => copy(blockText)}>
        <CopyIcon />
        Copy Block
      </ContextMenu.Item>
    ) : null

  if (!copyMessage || !copyBlock) return copyMessage ?? copyBlock

  return (
    <ContextMenu.Sub>
      <ContextMenu.SubTrigger>
        <CopyIcon />
        Copy
      </ContextMenu.SubTrigger>
      <ContextMenu.SubContent>
        {copyBlock}
        {copyMessage}
      </ContextMenu.SubContent>
    </ContextMenu.Sub>
  )
}

type DeleteMenuProps = {
  deleteState: MenuState['delete']
  contextReset?: boolean
  onDeleteAttachment?: () => void
  onDeleteBlock: () => void
  onDeleteMessage: () => void
}

export function DeleteMenu({
  deleteState,
  contextReset,
  onDeleteAttachment,
  onDeleteBlock,
  onDeleteMessage,
}: DeleteMenuProps) {
  if (onDeleteAttachment || deleteState.submenu) {
    return (
      <ContextMenu.Sub>
        <ContextMenu.SubTrigger>
          <Trash2Icon />
          Delete
        </ContextMenu.SubTrigger>
        <ContextMenu.SubContent>
          {onDeleteAttachment ? (
            <ContextMenu.Item
              variant="destructive"
              onSelect={onDeleteAttachment}
            >
              <Trash2Icon />
              Delete Attachment
            </ContextMenu.Item>
          ) : (
            <ContextMenu.Item variant="destructive" onSelect={onDeleteBlock}>
              <Trash2Icon />
              Delete Block
            </ContextMenu.Item>
          )}
          <ContextMenu.Item variant="destructive" onSelect={onDeleteMessage}>
            <Trash2Icon />
            Delete Message
          </ContextMenu.Item>
        </ContextMenu.SubContent>
      </ContextMenu.Sub>
    )
  }

  return (
    <ContextMenu.Item variant="destructive" onSelect={onDeleteMessage}>
      <Trash2Icon />
      {contextReset ? 'Delete' : 'Delete Message'}
    </ContextMenu.Item>
  )
}
