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
import {
  type AttachmentDeletion,
  selectAttachmentDeletion,
} from './attachment-deletion'
import {
  type DeleteConfirmation,
  DeleteConfirmations,
} from './delete-confirmations'
import { MESSAGE_MENU_TRIGGER_CLASS } from './forward-message-menu'
import { CopyMenu, DeleteMenu, EditMenu } from './message-menu-items'
import {
  type GroupScope,
  getMessageContextMenuState,
  resolveHeaderScope,
  resolveMessageMenuScope,
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

type MenuSelection = {
  scope: GroupScope | null
  target: MessageTarget | null
  deletion: AttachmentDeletion | null
  selectedText?: string
}

function getSelectedText(): string | undefined {
  return document.getSelection()?.toString() || undefined
}

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
  const [confirm, setConfirm] = useState<DeleteConfirmation | null>(null)
  const [selection, setSelection] = useState<MenuSelection | null>(null)
  const editingMessageId = editCtx?.editingMessageId
  const isEditingThisMessage = editingMessageId === message.id

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
  const scope = selection ? selection.scope : groupScope
  const reply = useReplyAction(message, record, scope)

  const menu = useMemo(
    () => getMessageContextMenuState(message, slices, record, scope, canMutate),
    [message, slices, record, scope, canMutate],
  )
  const hasEdit = menu.edit.submenu || Boolean(menu.edit.messageText)
  const messageCopyText = selection?.selectedText ?? menu.copy.messageText
  const hasCopy = menu.copy.blockText !== undefined || Boolean(messageCopyText)
  const hasEditOrCopy = hasEdit || hasCopy
  const hasMessageActions = reply || menu.retry || hasEditOrCopy || menu.delete.message // prettier-ignore
  const messageTarget = selection?.target
  const attachmentDeletion = canMutate ? selection?.deletion : null
  const hasTargetActions = messageTarget?.download || messageTarget?.link

  function preserveSelection(event: React.MouseEvent) {
    if (event.button !== 2 || event.shiftKey) return
    // WebKit can clear the selection before dispatching contextmenu.
    if (getSelectedText()) event.preventDefault()
  }

  function handleOpen({ x, y, target }: ContextMenuOpenTarget) {
    const nextTarget = resolveMessageTarget(target)
    // Preload the editor in case the user intends to edit the message
    if (canMutate) prefetchRichTextEditor()
    editSelectionRef.current = captureMessageEditSelection(message.id, x, y)

    const next = target ? (groupScope ?? resolveHeaderScope(row, target)) : null
    const deletion = canMutate
      ? selectAttachmentDeletion({
          tile: nextTarget?.attachment,
          scope: next,
          slices,
          message,
          record,
        })
      : null

    setSelection({
      scope: next,
      target: nextTarget,
      deletion,
      selectedText: getSelectedText(),
    })
    if (ownsHighlightRef.current) highlightScope(next, nextTarget)
  }

  function handleOpenChange(open: boolean) {
    if (!highlight) return
    if (open) {
      ownsHighlightRef.current = true
      highlightScope(scope, messageTarget ?? null)
      return
    }

    if (ownsHighlightRef.current) {
      ownsHighlightRef.current = false
      highlight.setTarget(null)
    }
  }

  function highlightScope(
    scope: GroupScope | null,
    target: MessageTarget | null,
  ) {
    if (!highlight) return
    if (target?.attachment) {
      highlight.setTarget({ attachment: target.attachment })
      return
    }
    const { hasDistinctBlock } = resolveMessageMenuScope(
      message.parts,
      slices,
      scope,
    )
    if (scope && hasDistinctBlock) {
      highlight.setTarget({
        messageId: message.id,
        ...scope,
        ...(row.kind === 'header' && { surface: 'header' }),
      })
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

  if (isEditingThisMessage) return children

  return (
    <>
      <ContextMenu onOpen={handleOpen} onOpenChange={handleOpenChange}>
        <ContextMenu.Trigger
          className={
            row.kind === 'context-reset'
              ? undefined
              : MESSAGE_MENU_TRIGGER_CLASS
          }
          onMouseDown={preserveSelection}
        >
          {children}
        </ContextMenu.Trigger>
        <ContextMenu.Content>
          {hasTargetActions && messageTarget && (
            <>
              <TargetActions target={messageTarget} />
              {hasMessageActions && <ContextMenu.Separator />}
            </>
          )}
          {reply && (
            <ContextMenu.Item
              onSelect={reply}
              disabled={Boolean(editingMessageId)}
            >
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
          <CopyMenu
            blockText={menu.copy.blockText}
            messageText={messageCopyText}
            hasSelection={selection?.selectedText !== undefined}
          />
          {menu.delete.message && (
            <>
              {(menu.retry || hasEditOrCopy) && <ContextMenu.Separator />}
              <DeleteMenu
                deleteState={menu.delete}
                contextReset={record?.type === 'contextReset'}
                onDeleteAttachment={
                  attachmentDeletion
                    ? () => setConfirm(attachmentDeletion)
                    : undefined
                }
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
