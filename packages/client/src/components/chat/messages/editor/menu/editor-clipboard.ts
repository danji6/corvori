import { pasteFromClipboard, writeClipboardText } from '@/lib/clipboard'
import { toast } from '@/lib/notifications'
import type { Editor } from '@tiptap/react'

export async function copyEditorSelection(editor: Editor, cut: boolean) {
  const { doc, selection } = editor.state
  if (selection.empty) return

  editor.view.focus()
  const { dom, text } = editor.view.serializeForClipboard(selection.content())
  try {
    await writeClipboardText(text, dom.innerHTML)
  } catch {
    toast.error('Could not copy to the clipboard')
    return
  }

  if (cut && !editor.isDestroyed && editor.state.doc === doc) {
    if (editor.state.selection.eq(selection)) editor.commands.deleteSelection()
  }
}

export async function pasteIntoEditor(editor: Editor) {
  const { doc, selection } = editor.state
  editor.view.focus()

  const pasted = await pasteFromClipboard(({ text, html }) => {
    if (editor.isDestroyed || editor.state.doc !== doc) return
    if (!editor.state.selection.eq(selection) || !editor.view.hasFocus()) return

    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', text)
    if (html) clipboardData.setData('text/html', html)
    editor.view.dom.dispatchEvent(
      new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData,
      }),
    )
  })
  if (!pasted) toast.info('Press Ctrl+V or ⌘V to paste')
}
