import { AlertDialog } from '@/components/ui'
import { createOptionalContext } from '@/hooks/context'
import type { PartAddress } from '@/lib/chat/parts'
import type { Editor } from '@tiptap/react'
import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

export type EditCaret =
  | { kind: 'text'; offset: number }
  | { kind: 'code'; blockIndex: number; offset: number }

export type PendingSelection = {
  text: string
  occurrenceIndex: number
  caret?: EditCaret
  caretOffset?: number
  scrollY?: number
  viewportTop?: number
  onEditorReady?: (editor: Editor) => void
}

export type EditOptions = {
  selectedText?: string
  occurrenceIndex?: number
  caret?: EditCaret
  caretOffset?: number
  scrollY?: number
  viewportTop?: number
  onEditorReady?: (editor: Editor) => void
  address?: PartAddress // when set, only this part is edited
}

export type MessageEditContextValue = {
  editingMessageId: string | null
  editingAddress: PartAddress | null
  completedEditRevision: number
  onSave: () => void
  onCancel: () => void
  replyQuoteRemoved: boolean
  onRemoveReplyQuote: () => void
  startEditing: (messageId: string, content: string, opts?: EditOptions) => void
  pendingSelection: PendingSelection | null
}

export type MessageEditDraftContextValue = {
  getDraft: () => string
  onDraftChange: (value: string) => void
}

export const [MessageEditContext, useMessageEdit] =
  createOptionalContext<MessageEditContextValue>()

export const [MessageEditDraftContext, useMessageEditDraft] =
  createOptionalContext<MessageEditDraftContextValue>()

type PendingRequest = {
  messageId: string
  content: string
  opts?: EditOptions
}

export type MessageEditChange = {
  id: string
  content?: string
  address?: PartAddress
  removeReplyQuote?: true
}

export type MessageEditProviderProps = {
  children: React.ReactNode
  onEdit: (change: MessageEditChange) => void
}

export function MessageEditProvider({
  children,
  onEdit,
}: MessageEditProviderProps) {
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null)
  const [editingAddress, setEditingAddress] = useState<PartAddress | null>(null)
  const [replyQuoteRemoved, setReplyQuoteRemoved] = useState(false)
  const draftRef = useRef('')
  const originalContentRef = useRef('')
  const addressRef = useRef<PartAddress | undefined>(undefined)
  const [pendingSelection, setPendingSelection] = useState<PendingSelection | null>(null) // prettier-ignore
  const [pendingRequest, setPendingRequest] = useState<PendingRequest | null>(null) // prettier-ignore
  const [completedEditRevision, setCompletedEditRevision] = useState(0)

  const latestRef = useRef({ editingMessageId, onEdit })
  useEffect(() => {
    latestRef.current = { editingMessageId, onEdit }
  }, [editingMessageId, onEdit])

  const clearState = useCallback(() => {
    setEditingMessageId(null)
    setEditingAddress(null)
    setReplyQuoteRemoved(false)
    setPendingSelection(null)
  }, [])

  const activate = useCallback(
    (messageId: string, content: string, opts?: EditOptions) => {
      draftRef.current = content
      originalContentRef.current = content
      addressRef.current = opts?.address
      setEditingMessageId(messageId)
      setEditingAddress(opts?.address ?? null)
      setReplyQuoteRemoved(false)
      setPendingSelection(
        opts && (opts.selectedText || opts.caret || opts.caretOffset != null)
          ? {
              text: opts.selectedText ?? '',
              occurrenceIndex: opts.occurrenceIndex ?? 0,
              caret: opts.caret,
              caretOffset: opts.caretOffset,
              scrollY: opts.scrollY,
              viewportTop: opts.viewportTop,
              onEditorReady: opts.onEditorReady,
            }
          : null,
      )
    },
    [],
  )

  const startEditing = useCallback(
    (messageId: string, content: string, opts?: EditOptions) => {
      if (
        latestRef.current.editingMessageId &&
        latestRef.current.editingMessageId !== messageId
      ) {
        setPendingRequest({ messageId, content, opts })
        return
      }
      startTransition(() => activate(messageId, content, opts))
    },
    [activate],
  )

  const saveDraft = useCallback(() => {
    const { editingMessageId: id, onEdit: edit } = latestRef.current
    if (!id) return false
    const content = draftRef.current.trim()
    const quoteOnly =
      replyQuoteRemoved && content === originalContentRef.current.trim()
    edit({
      id,
      content: quoteOnly ? undefined : content,
      address: addressRef.current,
      ...(replyQuoteRemoved && { removeReplyQuote: true }),
    })
    return true
  }, [replyQuoteRemoved])

  const onSave = useCallback(() => {
    if (saveDraft()) {
      setCompletedEditRevision((revision) => revision + 1)
    }
    clearState()
  }, [clearState, saveDraft])

  const onCancel = useCallback(() => {
    if (latestRef.current.editingMessageId) {
      setCompletedEditRevision((revision) => revision + 1)
    }
    clearState()
  }, [clearState])

  function finishSwitch() {
    const req = pendingRequest
    setPendingRequest(null)
    clearState()
    if (req) {
      startTransition(() => activate(req.messageId, req.content, req.opts))
    } else if (latestRef.current.editingMessageId) {
      setCompletedEditRevision((revision) => revision + 1)
    }
  }

  function handleConfirmSave() {
    saveDraft()
    finishSwitch()
  }

  const onRemoveReplyQuote = useCallback(() => setReplyQuoteRemoved(true), [])

  const contextValue = useMemo<MessageEditContextValue>(
    () => ({
      editingMessageId,
      editingAddress,
      completedEditRevision,
      onSave,
      onCancel,
      replyQuoteRemoved,
      onRemoveReplyQuote,
      startEditing,
      pendingSelection,
    }),
    [
      editingMessageId,
      editingAddress,
      completedEditRevision,
      onSave,
      onCancel,
      replyQuoteRemoved,
      onRemoveReplyQuote,
      startEditing,
      pendingSelection,
    ],
  )

  const onDraftChange = useCallback((value: string) => {
    draftRef.current = value
  }, [])

  const getDraft = useCallback(() => draftRef.current, [])

  const draftContextValue = useMemo<MessageEditDraftContextValue>(
    () => ({ getDraft, onDraftChange }),
    [getDraft, onDraftChange],
  )

  return (
    <MessageEditContext.Provider value={contextValue}>
      <MessageEditDraftContext.Provider value={draftContextValue}>
        {children}
        <AlertDialog
          open={!!pendingRequest}
          onOpenChange={(open) => {
            if (!open) setPendingRequest(null)
          }}
        >
          <AlertDialog.Content>
            <AlertDialog.Header>
              <AlertDialog.Title>Unsaved changes</AlertDialog.Title>
              <AlertDialog.Description>
                You have unsaved changes in another message. What would you like
                to do?
              </AlertDialog.Description>
            </AlertDialog.Header>
            <AlertDialog.Footer>
              <AlertDialog.Cancel>Keep editing</AlertDialog.Cancel>
              <AlertDialog.Action variant="destructive" onClick={finishSwitch}>
                Discard
              </AlertDialog.Action>
              <AlertDialog.Action onClick={handleConfirmSave}>
                Save
              </AlertDialog.Action>
            </AlertDialog.Footer>
          </AlertDialog.Content>
        </AlertDialog>
      </MessageEditDraftContext.Provider>
    </MessageEditContext.Provider>
  )
}
