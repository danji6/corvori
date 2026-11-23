import type { PendingMessage } from '@/lib/chat'
import {
  composerShellText,
  serializeComposerContent,
  setComposerContent,
} from '@/lib/chat/composer-content'
import { useComposerDraft } from '@/lib/chat/composer-draft-store'
import { listenForComposerInsertion } from '@/lib/chat/composer-insert'
import { registerFocusReturn } from '@/lib/focus-return'
import type { Editor } from '@tiptap/react'
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react'
import type { MouseEvent, Ref, RefObject } from 'react'

import { useComposerCloseGuard } from './composer-close-guard'

const INTERACTIVE = 'a,button,img,input,select,textarea,[contenteditable]'

// Only one composer is mounted, so it shares a fixed fullscreen view id.
export const COMPOSER_FULLSCREEN_ID = 'composer'

/** Imperative handle exposed to parents for focusing the composer. */
export type ComposerHandle = {
  focus: (options?: FocusOptions) => void
  /** Inserts a starter only while the composer is empty and restored. */
  insertStarter: (markdown: string) => void
  openAttachments: () => void
  prepareDraftMove: () => ((destination: string) => Promise<void>) | null
}

type UseComposerEditorOptions = {
  draftKey?: string
  editorRef: RefObject<Editor | null>
  inputRef?: Ref<ComposerHandle>
  onRestoreMessage: (message: PendingMessage) => void
  onTyping?: () => void
  canInsertStarter?: boolean
  onAddFiles?: () => void
  prepareAttachmentMove?: () => ((destination: string) => Promise<void>) | null
}

/** Owns composer editor state, draft restoration, and editor lifecycle effects. */
export function useComposerEditor({
  draftKey,
  editorRef,
  inputRef,
  onRestoreMessage,
  onTyping,
  canInsertStarter = false,
  onAddFiles,
  prepareAttachmentMove,
}: UseComposerEditorOptions) {
  useComposerCloseGuard(editorRef)
  const draft = useComposerDraft(draftKey)

  useEffect(
    () =>
      listenForComposerInsertion((text) => {
        const editor = editorRef.current
        if (!editor?.isEditable) return false
        editor
          .chain()
          .focus()
          .insertContent({
            type: 'paragraph',
            content: [{ type: 'text', text }],
          })
          .run()
        return true
      }),
    [editorRef],
  )

  const [message, setMessage] = useState('')
  const [isReady, setIsReady] = useState(false)
  const [caret, setCaret] = useState(0)
  const [isShellMode, setIsShellMode] = useState(false)
  const suppressTypingRef = useRef(false)

  const draftRef = useRef(draft)
  const onRestoreMessageRef = useRef(onRestoreMessage)
  const onTypingRef = useRef(onTyping)

  useEffect(() => {
    draftRef.current = draft
  }, [draft])

  useEffect(() => {
    onRestoreMessageRef.current = onRestoreMessage
  }, [onRestoreMessage])

  useEffect(() => {
    onTypingRef.current = onTyping
  }, [onTyping])

  const applyContent = useCallback((editor: Editor, content: string) => {
    if (content) suppressTypingRef.current = true
    setComposerContent(editor, content)
  }, [])

  useImperativeHandle(
    inputRef,
    () => ({
      focus: (options) => editorRef.current?.view.dom.focus(options),
      insertStarter: (markdown) => {
        const editor = editorRef.current
        if (!editor || !canInsertStarter) return
        if (editor.state.doc.textContent.trim()) return
        applyContent(editor, markdown)
        editor.commands.focus('end')
      },
      openAttachments: () => onAddFiles?.(),
      prepareDraftMove: () => {
        const editor = editorRef.current
        const moveAttachments = prepareAttachmentMove?.()
        if (!editor || !moveAttachments) return null
        const text = serializeComposerContent(editor)
        const currentDraft = draft
        return async (destination) => {
          await moveAttachments(destination)
          currentDraft.moveTo(destination, text)
        }
      },
    }),
    [
      applyContent,
      canInsertStarter,
      draft,
      editorRef,
      onAddFiles,
      prepareAttachmentMove,
    ],
  )

  useEffect(
    () => registerFocusReturn(() => editorRef.current?.view.dom ?? null),
    [editorRef],
  )

  const syncFromEditor = useCallback((editor: Editor) => {
    const { doc, selection } = editor.state
    setMessage(doc.textBetween(0, doc.content.size, '\n'))
    setCaret(doc.textBetween(0, selection.from, '\n').length)
    setIsShellMode(composerShellText(doc) !== null)
  }, [])

  const restoredKeyRef = useRef<string>(undefined)
  const restoreDraft = useCallback(
    (editor: Editor) => {
      if (!draftKey || restoredKeyRef.current === draftKey) return
      restoredKeyRef.current = draftKey
      const saved = draftRef.current.read()
      if (saved && editor.isEmpty) applyContent(editor, saved)
    },
    [applyContent, draftKey],
  )

  useEffect(() => {
    const editor = editorRef.current
    if (editor) restoreDraft(editor)
  }, [editorRef, restoreDraft])

  const restorePendingMessage = useCallback(
    (message: PendingMessage) => {
      const editor = editorRef.current
      if (!editor || editor.isDestroyed) return false
      applyContent(editor, message.content)
      onRestoreMessageRef.current(message)
      return true
    },
    [applyContent, editorRef],
  )

  const handleEditorReady = useCallback(
    (editor: Editor) => {
      editorRef.current = editor
      editor.on('update', () => {
        syncFromEditor(editor)
        draftRef.current.save(serializeComposerContent(editor))
        if (suppressTypingRef.current) {
          suppressTypingRef.current = false
          return
        }
        if (editor.state.doc.textContent.trim().length > 0) {
          onTypingRef.current?.()
        }
      })
      editor.on('selectionUpdate', () => syncFromEditor(editor))
      restoreDraft(editor)
      syncFromEditor(editor)
      setIsReady(true)
    },
    [editorRef, restoreDraft, syncFromEditor],
  )

  const handleSurfaceMouseDown = useCallback(
    (event: MouseEvent) => {
      const target = event.target as HTMLElement
      if (!event.currentTarget.contains(target)) return
      if (event.button !== 0 || target.closest(INTERACTIVE)) return
      event.preventDefault()
      const editor = editorRef.current
      if (!editor) return
      editor.view.dom.focus({ preventScroll: true })
      editor.commands.focus(null, { scrollIntoView: false })
    },
    [editorRef],
  )

  const clearEditor = useCallback(() => {
    editorRef.current?.commands.clearContent(true)
    setMessage('')
    setCaret(0)
    setIsShellMode(false)
    draftRef.current.clear()
  }, [editorRef])

  const setEditorText = useCallback(
    (text: string) => {
      editorRef.current?.chain().setContent(text).focus('end').run()
    },
    [editorRef],
  )

  return {
    caret,
    clearEditor,
    handleEditorReady,
    handleSurfaceMouseDown,
    isShellMode,
    message,
    isReady,
    restorePendingMessage,
    setEditorText,
  }
}
