import { Extension } from '@tiptap/core'
import type { Node } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

const paragraphLinesKey = new PluginKey<DecorationSet>('paragraphLines')

/** Keeps the prose line height on text while blank lines use the block gap. */
export const ParagraphLines = Extension.create({
  name: 'paragraphLines',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: paragraphLinesKey,
        state: {
          init: (_, { doc }) => decorateParagraphs(doc),
          apply: (tr, previous) =>
            tr.docChanged ? decorateParagraphs(tr.doc) : previous,
        },
        props: {
          decorations: (state) => paragraphLinesKey.getState(state),
        },
      }),
    ]
  },
})

function decorateParagraphs(doc: Node): DecorationSet {
  const { paragraph, hardBreak } = doc.type.schema.nodes
  const decorations: Decoration[] = []

  doc.forEach((node, pos) => {
    if (node.type !== paragraph) return

    const hasBlankLine = node.content.content.some(
      (child, index, siblings) =>
        child.type === hardBreak && siblings[index - 1]?.type === hardBreak,
    )
    if (!hasBlankLine) return

    const end = pos + node.nodeSize
    decorations.push(
      Decoration.node(pos, end, { class: 'chat-markdown-paragraph' }),
      Decoration.inline(pos + 1, end - 1, { class: 'chat-markdown-text' }),
    )
  })

  return DecorationSet.create(doc, decorations)
}
