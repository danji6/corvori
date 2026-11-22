import {
  leafText,
  serializeBlocksToMarkdown,
  setEditorMarkdown,
} from '@/lib/tiptap/serialize'
import { SHELL_PREFIX, parseShellCommand } from '@cv/core/shell/command'
import { Fragment, type Node, type Schema, Slice } from '@tiptap/pm/model'
import type { Editor } from '@tiptap/react'

/** Reads a shell invocation, including its prefix, from a leading paragraph. */
export function composerShellText(doc: Node): string | null {
  if (doc.firstChild?.type.name !== 'paragraph') return null
  if (!doc.firstChild.firstChild?.text?.startsWith(SHELL_PREFIX)) return null

  const text = doc.textBetween(0, doc.content.size, '\n', leafText)
  return parseShellCommand(text) === null ? null : text
}

/** Preserves the shell source when saving drafts or sending messages. */
export function serializeComposerContent(editor: Editor): string {
  return (
    composerShellText(editor.state.doc) ?? serializeBlocksToMarkdown(editor)
  )
}

/** Restores a shell draft without interpreting its command as Markdown. */
export function setComposerContent(editor: Editor, content: string): void {
  if (parseShellCommand(content) === null) {
    setEditorMarkdown(editor, content)
    return
  }

  const { schema } = editor
  const paragraph = schema.nodes.paragraph.create(
    null,
    literalLines(schema, content),
  )
  const doc = schema.topNodeType.create(null, paragraph)
  editor.chain().setMeta('preventAutolink', true).setContent(doc).run()
}

/** Inserts clipboard text literally if the resulting message is a shell command. */
export function pasteComposerShellText(editor: Editor, text: string): boolean {
  if (!text) return false

  const { doc, schema } = editor.state
  const leadingText = doc.firstChild?.firstChild?.text
  if (
    !text.startsWith(SHELL_PREFIX) &&
    !leadingText?.startsWith(SHELL_PREFIX)
  ) {
    return false
  }

  const slice = new Slice(literalLines(schema, text), 0, 0)
  const tr = editor.state.tr.replaceSelection(slice)
  if (!tr.docChanged || composerShellText(tr.doc) === null) return false

  editor.view.dispatch(tr.setMeta('preventAutolink', true).scrollIntoView())
  return true
}

/** Converts clipboard line breaks to editable breaks while keeping other text. */
function literalLines(schema: Schema, text: string): Fragment {
  const lines = text.split(/\r\n?|\n/)
  const nodes: Node[] = []
  lines.forEach((line, index) => {
    if (index > 0) nodes.push(schema.nodes.hardBreak.create())
    if (line) nodes.push(schema.text(line))
  })
  return Fragment.fromArray(nodes)
}
