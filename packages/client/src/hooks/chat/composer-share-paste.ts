import type { SharedAttachment } from '@/lib/chat/types'
import { multilinePasteText } from '@/lib/tiptap/paste'
import { serializeSliceToMarkdown } from '@/lib/tiptap/serialize'
import { api } from '@cv/convex/_generated/api'
import { attachmentShare } from '@cv/core/attachments'
import {
  markdownHttpLinks,
  removeMarkdownLinks,
} from '@cv/core/utils/markdown-links'
import type { Slice } from '@tiptap/pm/model'
import { Selection, type Transaction } from '@tiptap/pm/state'
import type { Editor } from '@tiptap/react'
import { type RequestForQueries, useQueries } from 'convex/react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

type Paste = {
  urls: string[]
  apply: (shares: SharedAttachment[]) => void
  dispose: () => void
}

const LOOKUP_TIMEOUT_MS = 5000

export function useComposerSharePaste(
  draftKey: string | undefined,
  addSharedFiles: (shares: SharedAttachment[]) => void,
) {
  const [queue, setQueue] = useState<Paste[]>([])
  const active = useRef(new Set<Paste>())
  const pending = queue[0]

  const queries = useMemo((): RequestForQueries => {
    if (!pending) return {}
    return {
      shares: {
        query: api.attachments.previewShares,
        args: { urls: pending.urls },
      },
    }
  }, [pending])

  const { shares: result } = useQueries(queries) as {
    shares?: (SharedAttachment | null)[] | Error
  }

  useLayoutEffect(() => {
    const pastes = active.current
    return () => {
      pastes.forEach((paste) => paste.dispose())
      pastes.clear()
    }
  }, [draftKey])

  useEffect(() => {
    if (!pending) return
    function complete(result: (SharedAttachment | null)[] | Error = []) {
      if (!active.current.delete(pending)) {
        setQueue((queue) => queue.slice(1))
        return
      }
      const shares =
        result instanceof Error ? [] : result.filter((share) => share !== null)
      pending.dispose()
      pending.apply(shares)
      addSharedFiles(shares)
      setQueue((queue) => queue.slice(1))
    }
    if (result !== undefined) {
      complete(result)
      return
    }
    const timeout = window.setTimeout(complete, LOOKUP_TIMEOUT_MS)
    return () => window.clearTimeout(timeout)
  }, [addSharedFiles, pending, result])

  function pasteShareLinks(
    editor: Editor,
    event: ClipboardEvent,
    slice: Slice,
  ) {
    const paste = captureSharePaste(editor, event, slice)
    if (!paste) return false
    active.current.add(paste)
    setQueue((queue) => [...queue, paste])
    return true
  }

  return { pasteShareLinks, isResolving: pending !== undefined }
}

function captureSharePaste(
  editor: Editor,
  event: ClipboardEvent,
  slice: Slice,
): Paste | null {
  if (editor.state.selection.$from.parent.type.spec.code) return null

  const clipboard = event.clipboardData
  let text = clipboard?.getData('text/plain') ?? ''
  if (
    !text.includes('#attachment=') &&
    clipboard?.getData('text/html').includes('#attachment=')
  ) {
    text = serializeSliceToMarkdown(editor, slice, { collapseBlocks: true })
  }
  if (!text.includes('#attachment=')) return null

  const links = markdownHttpLinks(text).filter(({ url }) =>
    attachmentShare(url),
  )
  if (links.length === 0) return null

  const multiline = multilinePasteText(editor, event)
  const position = trackPastePosition(editor)

  return {
    urls: [...new Set(links.map(({ url }) => url))],
    dispose: position.dispose,
    apply(shares) {
      if (editor.isDestroyed) return
      const matched = new Set(shares.map((share) => share.shareUrl))
      const removed = links.filter(({ url }) => matched.has(url))
      const range = position.range()
      if (removed.length === 0 && multiline === null) {
        insertClipboardSlice(editor, slice, range)
        return
      }
      const remaining = removed.length
        ? removeMarkdownLinks(text, removed)
        : multiline!
      if (removed.length && !remaining.trim()) return
      editor.commands.insertContentAt(
        range,
        remaining.replace(/\r\n?|\n/g, '\n\n'),
        {
          contentType: 'markdown',
          updateSelection: isCurrentSelection(editor, range),
        },
      )
    },
  }
}

type PasteRange = { from: number; to: number }

/** Follows the insertion point while a share lookup is in flight. */
function trackPastePosition(editor: Editor) {
  const { doc, selection } = editor.state
  const selected = doc.slice(selection.from, selection.to)
  let { from, to } = selection
  function track({
    transaction,
    appendedTransactions,
  }: {
    transaction: Transaction
    appendedTransactions: Transaction[]
  }) {
    for (const { mapping } of [transaction, ...appendedTransactions]) {
      const end = from === to ? 1 : -1
      from = mapping.map(from, 1)
      to = Math.max(from, mapping.map(to, end))
    }
  }
  editor.on('transaction', track)
  return {
    dispose: () => editor.off('transaction', track),
    range: () => ({
      from,
      to: editor.state.doc.slice(from, to).eq(selected) ? to : from,
    }),
  }
}

function isCurrentSelection(editor: Editor, { from, to }: PasteRange) {
  const { selection } = editor.state
  return selection.from === from && selection.to === to
}

function insertClipboardSlice(
  editor: Editor,
  slice: Slice,
  { from, to }: PasteRange,
) {
  if (slice.size === 0) return
  const tr = editor.state.tr.replaceRange(from, to, slice)
  if (isCurrentSelection(editor, { from, to })) {
    tr.setSelection(Selection.near(tr.doc.resolve(tr.mapping.map(to, 1)), -1))
  }
  editor.view.dispatch(tr.setMeta('paste', true).setMeta('uiEvent', 'paste'))
}
