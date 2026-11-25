import type { Editor } from '@tiptap/react'
import type { TextUIPart } from 'ai'
import React, { Suspense, lazy, useLayoutEffect, useRef, useState } from 'react'

import { useMessage } from '../message-context'
import { useMessageList } from '../message-list/message-list-context'
import { SmoothText } from '../smooth-text'
import { BubbleMenu } from './menu/bubble-menu'
import { useMessageEdit, useMessageEditDraft } from './message-edit-context'

const importEditor = () =>
  import('./inline-editor').then((module) => ({
    default: module.InlineEditor,
  }))

let editorChunk: ReturnType<typeof importEditor> | null = null

export function prefetchRichTextEditor(): Promise<unknown> {
  return (editorChunk ??= importEditor())
}

const RichTextEditor = lazy(prefetchRichTextEditor as typeof importEditor)

export type EditableTextProps = Omit<React.ComponentProps<'div'>, 'part'> & {
  part: TextUIPart
  /** The segment this part belongs to (0 when the message isn't split). */
  segmentIndex?: number
  /** This part's index within its segment. */
  index?: number
}

export function EditableText({
  part,
  segmentIndex,
  index,
  children,
  style,
  ...props
}: EditableTextProps) {
  const editCtx = useMessageEdit()
  const draftCtx = useMessageEditDraft()
  const msgCtx = useMessage()
  const messageList = useMessageList()
  const scrollRef = messageList?.scrollRef
  const onLayoutChange = messageList?.onLayoutChange
  const scrollCoordinator = messageList?.scrollCoordinator
  const isStreaming = part.state === 'streaming'

  const editingAddress = editCtx?.editingAddress ?? null
  const pendingSelection = editCtx?.pendingSelection
  const replyQuoteRemoved = editCtx?.replyQuoteRemoved
  const isEditing =
    editCtx?.editingMessageId === msgCtx?.id &&
    (editingAddress == null ||
      (editingAddress.segmentIndex === (segmentIndex ?? 0) &&
        editingAddress.partIndex === index))
  const shouldEdit = isEditing && !isStreaming

  const [editorInstance, setEditorInstance] = useState<Editor | null>(null)
  const editorReady = editorInstance !== null

  if (!shouldEdit && editorInstance !== null) {
    setEditorInstance(null)
  }

  const scrollCheckpoint = useRef<(() => boolean) | undefined>(undefined)
  useLayoutEffect(() => {
    if (!shouldEdit || editorReady) return
    const cancel = onLayoutChange?.('top')
    scrollCheckpoint.current = scrollCoordinator?.checkpoint()
    return cancel
  }, [shouldEdit, editorReady, onLayoutChange, scrollCoordinator])

  const appliedScrollRef = useRef(0)
  const entryScrollRef = useRef(0)

  // Release the layout hold before focusing, then account for any revealed markup.
  useLayoutEffect(() => {
    if (!editorInstance) return
    editorInstance.view.focus()
    const scrollEl = scrollRef?.current
    const viewportTop = pendingSelection?.viewportTop
    const canAlign = scrollCheckpoint.current?.() !== false
    if (scrollEl && viewportTop !== undefined && canAlign) {
      const before = readScroll(scrollEl)
      alignEditorSelection(editorInstance, scrollEl, viewportTop)
      const after = readScroll(scrollEl)
      appliedScrollRef.current += after - before
      entryScrollRef.current = after
    }
    pendingSelection?.onEditorReady?.(editorInstance)
  }, [editorInstance, pendingSelection, scrollRef])

  useLayoutEffect(() => {
    if (shouldEdit && replyQuoteRemoved) {
      editorInstance?.view.dom.focus({ preventScroll: true })
    }
  }, [editorInstance, shouldEdit, replyQuoteRemoved])

  // Reverse the entry compensation when leaving edit mode
  const wasEditingRef = useRef(false)
  useLayoutEffect(() => {
    if (shouldEdit) {
      wasEditingRef.current = true
      return
    }
    if (!wasEditingRef.current) return
    wasEditingRef.current = false

    const applied = appliedScrollRef.current
    appliedScrollRef.current = 0
    const scrollEl = scrollRef?.current
    if (!applied || !scrollEl) return

    // Only reverse if the user hasn't manually scrolled away
    if (Math.abs(readScroll(scrollEl) - entryScrollRef.current) > 2) return
    adjustScroll(scrollEl, -applied)
  }, [shouldEdit, scrollRef])

  return (
    <div
      className="w-full"
      style={{ ...style, ...(shouldEdit ? { display: 'grid' } : {}) }}
      {...props}
    >
      {shouldEdit && editCtx ? (
        <>
          {!editorReady && (
            <div
              className="w-full"
              style={{ gridArea: '1/1', pointerEvents: 'none' }}
            >
              <SmoothText part={part} />
            </div>
          )}
          <div
            className="min-w-0"
            style={{
              gridArea: '1/1',
              opacity: editorReady ? 1 : 0,
            }}
          >
            <BubbleMenu editor={editorInstance ?? undefined}>
              <Suspense fallback={null}>
                <RichTextEditor
                  initialMarkdown={draftCtx!.getDraft()}
                  onChange={draftCtx!.onDraftChange}
                  onSave={editCtx.onSave}
                  onCancel={editCtx.onCancel}
                  pendingSelection={editCtx.pendingSelection}
                  onReady={setEditorInstance}
                />
              </Suspense>
            </BubbleMenu>
          </div>
        </>
      ) : (
        children
      )}
    </div>
  )
}

function alignEditorSelection(
  editor: Editor,
  scrollEl: HTMLElement,
  viewportTop: number,
) {
  const { from } = editor.state.selection
  if (from === 0) return
  try {
    const delta = editor.view.coordsAtPos(from).top - viewportTop
    if (Math.abs(delta) > 1) adjustScroll(scrollEl, delta)
  } catch {
    // The editor may not have a DOM position for this selection yet.
  }
}

function adjustScroll(scrollEl: HTMLElement, delta: number) {
  if (scrollEl === document.documentElement) {
    window.scrollBy(0, delta)
  } else {
    scrollEl.scrollTop += delta
  }
}

function readScroll(scrollEl: HTMLElement): number {
  return scrollEl === document.documentElement
    ? window.scrollY
    : scrollEl.scrollTop
}
