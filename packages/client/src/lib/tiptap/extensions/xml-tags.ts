import { INDENT_UNIT } from '@/lib/tiptap/code-pairs'
import { isEmptyXmlTagPair, xmlTagToClose } from '@cv/core/xml-tags'
import { Extension } from '@tiptap/core'
import { closeHistory } from '@tiptap/pm/history'
import { Fragment, Slice } from '@tiptap/pm/model'
import type { Transaction } from '@tiptap/pm/state'
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import { ReplaceAroundStep } from '@tiptap/pm/transform'
import type { EditorView } from '@tiptap/pm/view'

const xmlTagsKey = new PluginKey('xmlTags')

/** Completes literal XML tags and indents empty pairs in every editor context. */
export const XmlTags = Extension.create({
  name: 'xmlTags',
  // Run before the interpreter (201) and code block (200) input handlers
  priority: 210,
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: xmlTagsKey,
        appendTransaction: (transactions, _previous, state) => {
          const expanded = transactions.some((tr) => tr.getMeta(xmlTagsKey))
          // Keep subsequent body typing in its own undo group
          return expanded ? closeHistory(state.tr) : null
        },
        props: {
          handleTextInput: closeTag,
          handleKeyDown: (view, event) => {
            if (event.key !== 'Enter' || event.isComposing) return false
            if (event.ctrlKey || event.metaKey || event.altKey) return false
            if (!expandTagPair(view)) return false
            event.preventDefault()
            return true
          },
        },
      }),
    ]
  },
})

function canExpand(view: EditorView): boolean {
  if (!view.editable || view.composing) return false
  const { selection } = view.state
  return selection instanceof TextSelection && selection.empty
}

/** Reads source text with one character per inline node to preserve positions. */
function caretText(view: EditorView) {
  const { $from } = view.state.selection
  const parent = $from.parent
  return {
    before: parent.textBetween(0, $from.parentOffset, '\n', '\ufffc'),
    after: parent.textBetween(
      $from.parentOffset,
      parent.content.size,
      '\n',
      '\ufffc',
    ),
  }
}

function closeTag(
  view: EditorView,
  from: number,
  to: number,
  text: string,
): boolean {
  if (text !== '>') return false
  if (from !== to || !canExpand(view)) return false
  const { before, after } = caretText(view)
  const name = xmlTagToClose(before + text, after)
  if (!name) return false

  const { state } = view
  const marks = state.storedMarks ?? state.doc.resolve(from).marks()
  const opening = state.schema.text(text, marks)
  const closing = state.schema.text(`</${name}>`, marks)
  insertExpansion(view, from, Fragment.from(opening), Fragment.from(closing))
  return true
}

function expandTagPair(view: EditorView): boolean {
  if (!canExpand(view)) return false
  const { before, after } = caretText(view)
  if (!isEmptyXmlTagPair(before, after)) return false

  const line = before.slice(before.lastIndexOf('\n') + 1)
  const indent = line.match(/^[ \t]*/)![0]
  const inner = indent + INDENT_UNIT
  const { state } = view
  const { from, $from } = state.selection
  const marks = state.storedMarks ?? $from.marks()

  if ($from.parent.type.spec.code) {
    const beforeCaret = Fragment.from(state.schema.text(`\n${inner}`, marks))
    const afterCaret = Fragment.from(state.schema.text(`\n${indent}`, marks))
    insertExpansion(view, from, beforeCaret, afterCaret)
    return true
  }

  const hardBreak = state.schema.nodes.hardBreak
  if (!hardBreak) return false
  if (!$from.parent.canReplaceWith($from.index(), $from.index(), hardBreak))
    return false

  const beforeCaret = Fragment.fromArray([
    hardBreak.create(),
    state.schema.text(inner, marks),
  ])
  const closingLine = [hardBreak.create()]
  if (indent) closingLine.push(state.schema.text(indent, marks))
  insertExpansion(view, from, beforeCaret, Fragment.fromArray(closingLine))
  return true
}

/** Keep both halves in one history event with the redo caret at their boundary. */
function insertExpansion(
  view: EditorView,
  from: number,
  beforeCaret: Fragment,
  afterCaret: Fragment,
) {
  // Undo removes the prefix first, so history places the redo caret at its end.
  // ReplaceAroundStep keeps the suffix separate when history combines steps.
  const suffix = new Slice(afterCaret, 0, 0)
  const tr = view.state.tr.step(
    new ReplaceAroundStep(from, from, from, from, suffix, 0),
  )
  tr.insert(from, beforeCaret)
  tr.setSelection(TextSelection.create(tr.doc, from + beforeCaret.size))
  dispatchExpansion(view, tr)
}

/** Keeps each expansion separate from preceding and following typing. */
function dispatchExpansion(view: EditorView, tr: Transaction): void {
  view.dispatch(closeHistory(tr).setMeta(xmlTagsKey, true).scrollIntoView())
}
