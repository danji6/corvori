import { SOURCE_DELIMITERS, isSourceFormat } from '@/lib/tiptap/inline-source'
import { linkSourceSuffix } from '@/lib/tiptap/source-links'
import type { JSONContent } from '@tiptap/core'
import type { Mark, Node, Schema } from '@tiptap/pm/model'
import { EditorState, type Transaction } from '@tiptap/pm/state'

type Insertion = { pos: number; text: string }
type MarkChanges = {
  insertions: Insertion[]
  removals: { from: number; to: number; mark: Mark }[]
}
type Wrapper = { name: string; open: string; close: string }

/** Chooses a code fence that cannot collide with the selected text. */
export function codeDelimiters(text: string): { open: string; close: string } {
  const runs = text.match(/`+/g) ?? []
  const fence = '`'.repeat(Math.max(0, ...runs.map((run) => run.length)) + 1)
  const padding = /^`|`$/.test(text) || (/^ .* $/.test(text) && text.trim()) ? ' ' : '' // prettier-ignore
  return { open: fence + padding, close: padding + fence }
}

function sourceWrapper(
  mark: Mark,
  node: Node,
  sourceLinks: boolean,
): Wrapper | null {
  const { name } = mark.type
  if (sourceLinks && name === 'link') {
    const { href, title } = mark.attrs
    if (typeof href !== 'string') return null
    return { name, open: '[', close: linkSourceSuffix(href, title) }
  }
  if (!isSourceFormat(name)) return null

  const delimiter = SOURCE_DELIMITERS[name]
  return {
    name,
    ...(name === 'code'
      ? codeDelimiters(node.text ?? '')
      : { open: delimiter, close: delimiter }),
  }
}

/** Converts incoming native formatting to delimiters in the same transaction. */
export function normalizeSourceMarks(
  tr: Transaction,
  sourceLinks = false,
): boolean {
  const changes: MarkChanges = { insertions: [], removals: [] }

  tr.doc.descendants((node, pos) => {
    if (node.type.spec.code) return false
    if (!node.isTextblock) return
    collectBlockChanges(node, pos, changes, sourceLinks)
    return false
  })

  for (const { from, to, mark } of changes.removals) {
    tr.removeMark(from, to, mark)
  }
  for (const entry of changes.insertions.reverse()) {
    tr.insert(entry.pos, tr.doc.type.schema.text(entry.text))
  }
  if (changes.removals.length) tr.setStoredMarks(null)

  return changes.removals.length > 0
}

function collectBlockChanges(
  node: Node,
  pos: number,
  changes: MarkChanges,
  sourceLinks: boolean,
): void {
  let active: Wrapper[] = []

  node.forEach((child, offset) => {
    const at = pos + 1 + offset
    const next: Wrapper[] = []
    for (const mark of child.marks) {
      const wrapper = sourceWrapper(mark, child, sourceLinks)
      if (!wrapper) continue
      if (child.isText) next.push(wrapper)
      changes.removals.push({ from: at, to: at + child.nodeSize, mark })
    }
    const text = transitionDelimiters(active, next)
    if (text) changes.insertions.push({ pos: at, text })
    active = next
  })

  const close = transitionDelimiters(active, [])
  if (close) {
    changes.insertions.push({ pos: pos + 1 + node.content.size, text: close })
  }
}

function transitionDelimiters(active: Wrapper[], next: Wrapper[]): string {
  const common = sharedWrappers(active, next)
  const close = active
    .slice(common)
    .reverse()
    .map((entry) => entry.close)
    .join('')
  const open = next
    .slice(common)
    .map((entry) => entry.open)
    .join('')

  return close + open
}

function sharedWrappers(left: Wrapper[], right: Wrapper[]): number {
  let common = 0
  while (common < left.length && common < right.length) {
    if (
      left[common].name !== right[common].name ||
      left[common].open !== right[common].open ||
      left[common].close !== right[common].close
    ) {
      break
    }
    common++
  }
  return common
}

/** Upgrades an older JSON draft before the editor establishes its baseline. */
export function normalizeSourceDocument(
  schema: Schema,
  content: JSONContent,
  sourceLinks = false,
): JSONContent {
  const state = EditorState.create({
    schema,
    doc: schema.nodeFromJSON(content),
  })
  const tr = state.tr
  return normalizeSourceMarks(tr, sourceLinks) ? tr.doc.toJSON() : content
}
