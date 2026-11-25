import { ContextMenu } from '@/components/ui'
import { CopyIcon, PencilIcon, Trash2Icon } from 'lucide-react'

import type { MenuState } from './message-menu-state'

function copy(text: string) {
  navigator.clipboard.writeText(text).catch(() => {})
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

type CopyMenuProps = {
  copy: MenuState['copy']
}

export function CopyMenu({ copy: copyState }: CopyMenuProps) {
  const { blockText, messageText } = copyState

  if (copyState.submenu && blockText !== undefined && messageText) {
    return (
      <ContextMenu.Sub>
        <ContextMenu.SubTrigger>
          <CopyIcon />
          Copy
        </ContextMenu.SubTrigger>
        <ContextMenu.SubContent>
          <ContextMenu.Item onSelect={() => copy(blockText)}>
            <CopyIcon />
            Copy Block
          </ContextMenu.Item>
          <ContextMenu.Item onSelect={() => copy(messageText)}>
            <CopyIcon />
            Copy Message
          </ContextMenu.Item>
        </ContextMenu.SubContent>
      </ContextMenu.Sub>
    )
  }

  if (blockText !== undefined) {
    return (
      <ContextMenu.Item onSelect={() => copy(blockText)}>
        <CopyIcon />
        Copy Block
      </ContextMenu.Item>
    )
  }

  if (!messageText) return null

  return (
    <ContextMenu.Item onSelect={() => copy(messageText)}>
      <CopyIcon />
      Copy Message
    </ContextMenu.Item>
  )
}

type DeleteMenuProps = {
  deleteState: MenuState['delete']
  contextReset?: boolean
  onDeleteBlock: () => void
  onDeleteMessage: () => void
}

export function DeleteMenu({
  deleteState,
  contextReset,
  onDeleteBlock,
  onDeleteMessage,
}: DeleteMenuProps) {
  if (deleteState.submenu) {
    return (
      <ContextMenu.Sub>
        <ContextMenu.SubTrigger>
          <Trash2Icon />
          Delete
        </ContextMenu.SubTrigger>
        <ContextMenu.SubContent>
          <ContextMenu.Item variant="destructive" onSelect={onDeleteBlock}>
            <Trash2Icon />
            Delete Block
          </ContextMenu.Item>
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
