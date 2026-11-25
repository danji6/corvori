import { ContextMenu } from '@/components/ui'
import type { ContextMenuOpenTarget } from '@/components/ui'
import { useRetryMessage } from '@/hooks/chat'
import type { MessageRecord } from '@/lib/chat'
import { type MessageRow, segmentGroupsFor } from '@/lib/chat/rows'
import type { UIMessage } from 'ai'
import { ReplyIcon, RotateCcwIcon } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'

import { prefetchRichTextEditor } from '../editor/editable-text'
import { useMessageEdit } from '../editor/message-edit-context'
import {
  type MessageEditSelectionSnapshot,
  captureMessageEditSelection,
  messageEditSelectionOptions,
} from '../message-edit-selection'
import {
  highlightTargetForRow,
  useMessageHighlight,
} from '../message-highlight-context'
import { useReplyAction } from '../reply-action'
import { DeleteConfirmations } from './delete-confirmations'
import { CopyMenu, DeleteMenu, EditMenu } from './message-menu-items'
import {
  type GroupScope,
  countGroups,
  getMessageContextMenuState,
  resolveHeaderScope,
} from './message-menu-state'
import {
  type MessageTarget,
  TargetActions,
  resolveMessageTarget,
} from './target-actions'

export type MessageContextMenuProps = {
  message: UIMessage
  record?: MessageRecord
  row: MessageRow
  canMutate: boolean
  children: React.ReactElement
}

type Confirm = 'part' | 'message'

export function MessageContextMenu({
  message,
  record,
  row,
  canMutate,
  children,
}: MessageContextMenuProps) {
  const editCtx = useMessageEdit()
  const retryMessage = useRetryMessage()
  const highlight = useMessageHighlight()
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [messageTarget, setMessageTarget] = useState<MessageTarget | null>(null)
  const isEditing = editCtx?.editingMessageId === message.id

  const editSelectionRef = useRef<MessageEditSelectionSnapshot | null>(null)
  const ownsHighlightRef = useRef(false)

  const slices = segmentGroupsFor(message, record)
  const groupScope = useMemo(
    () =>
      row.kind === 'group'
        ? { segmentIndex: row.segmentIndex, groupIndex: row.groupIndex }
        : null,
    [row],
  )
  const [selectedScope, setSelectedScope] = useState<GroupScope | null>(null)
  const scopeRef = useRef<GroupScope | null>(null)
  const scope = groupScope ?? selectedScope
  const reply = useReplyAction(message, record, scope)

  const menu = useMemo(
    () => getMessageContextMenuState(message, slices, record, scope, canMutate),
    [message, slices, record, scope, canMutate],
  )
  const hasEdit = menu.edit.submenu || Boolean(menu.edit.messageText)
  const hasCopy =
    menu.copy.blockText !== undefined || Boolean(menu.copy.messageText)
  const hasEditOrCopy = hasEdit || hasCopy
  const hasMessageActions =
    reply || menu.retry || hasEditOrCopy || menu.delete.message

  function handleOpen({ x, y, target }: ContextMenuOpenTarget) {
    setMessageTarget(resolveMessageTarget(target))
    // Preload the editor in case the user intends to edit the message
    if (canMutate) prefetchRichTextEditor()
    editSelectionRef.current = captureMessageEditSelection(message.id, x, y)
    const next = groupScope ?? resolveHeaderScope(row, target)
    scopeRef.current = next
    if (!groupScope) setSelectedScope(next)
    if (ownsHighlightRef.current) highlightScope(next)
  }

  function handleOpenChange(open: boolean) {
    if (!highlight) return
    if (open) {
      ownsHighlightRef.current = true
      highlightScope(scopeRef.current)
      return
    }

    if (ownsHighlightRef.current) {
      ownsHighlightRef.current = false
      highlight.setTarget(null)
    }
  }

  function highlightScope(scope: GroupScope | null) {
    if (!highlight) return
    if (scope && countGroups(slices) > 1) {
      highlight.setTarget({
        messageId: message.id,
        ...scope,
        ...(row.kind === 'header' && { surface: 'header' }),
      })
      return
    }
    if (row.kind === 'header' && !scope) {
      highlight.setTarget({ senderGroupId: row.messageId })
      return
    }
    highlight.setTarget(highlightTargetForRow(message.id, null))
  }

  function startEditBlock() {
    const block = menu.edit.block
    if (!block) return
    editCtx?.startEditing(message.id, block.text, {
      address: block.address,
      ...messageEditSelectionOptions(editSelectionRef.current, 'block'),
    })
  }

  function startEditMessage() {
    const { messageText } = menu.edit
    if (!messageText) return
    editCtx?.startEditing(message.id, messageText, {
      ...messageEditSelectionOptions(editSelectionRef.current, 'message'),
    })
  }

  if (isEditing) return children

  return (
    <>
      <ContextMenu onOpen={handleOpen} onOpenChange={handleOpenChange}>
        <ContextMenu.Trigger>{children}</ContextMenu.Trigger>
        <ContextMenu.Content>
          {messageTarget && (
            <>
              <TargetActions target={messageTarget} />
              {hasMessageActions && <ContextMenu.Separator />}
            </>
          )}
          {reply && (
            <ContextMenu.Item onSelect={reply}>
              <ReplyIcon />
              Reply
            </ContextMenu.Item>
          )}
          {menu.retry && (
            <>
              <ContextMenu.Item onSelect={() => retryMessage(message.id)}>
                <RotateCcwIcon />
                Retry
              </ContextMenu.Item>
              {hasEditOrCopy && <ContextMenu.Separator />}
            </>
          )}
          <EditMenu
            edit={menu.edit}
            onEditBlock={startEditBlock}
            onEditMessage={startEditMessage}
          />
          <CopyMenu copy={menu.copy} />
          {menu.delete.message && (
            <>
              {(menu.retry || hasEditOrCopy) && <ContextMenu.Separator />}
              <DeleteMenu
                deleteState={menu.delete}
                contextReset={record?.type === 'contextReset'}
                onDeleteBlock={() => setConfirm('part')}
                onDeleteMessage={() => setConfirm('message')}
              />
            </>
          )}
        </ContextMenu.Content>
      </ContextMenu>

      <DeleteConfirmations
        open={confirm}
        onClose={() => setConfirm(null)}
        messageId={message.id}
        isSpecialMessage={Boolean(record?.type)}
        deleteState={menu.delete}
      />
    </>
  )
}
