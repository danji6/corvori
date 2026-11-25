import type { JSONContent, MarkdownToken } from '@tiptap/core'
import type { EditorView } from '@tiptap/pm/view'

/** Finds the source offsets of a link's visible label. */
export function linkLabelRange(token: MarkdownToken) {
  const raw = token.raw ?? ''
  if (raw.startsWith('<')) return { from: 1, to: raw.length - 1 }
  if (!raw.startsWith('[')) return null

  const label = token.text ?? ''
  for (const match of raw.matchAll(/\]\(/g)) {
    const to = match.index
    const candidate = raw.slice(1, to).replaceAll('\\[', '[').replaceAll('\\]', ']') // prettier-ignore
    if (candidate === label) return { from: 1, to }
  }
  return null
}

/** Builds a Markdown destination for a resolved or pasted link. */
export function linkSourceSuffix(href: string, title?: string | null): string {
  const escapedHref = href.replaceAll('\\', '\\\\')
  const destination = /[\s()<>]/.test(href)
    ? `<${escapedHref.replace(/[<>]/g, '\\$&')}>`
    : escapedHref
  const quotedTitle = title?.replace(/["\\]/g, '\\$&')
  return `](${destination}${quotedTitle ? ` "${quotedTitle}"` : ''})`
}

/** Keeps inline links and autolinks editable, resolving reference destinations. */
export function parseLinkSource(token: MarkdownToken): JSONContent {
  const raw = token.raw ?? ''
  const isReference = raw.startsWith('[') && !linkLabelRange(token)
  const text = isReference
    ? `[${token.text ?? ''}${linkSourceSuffix(token.href, token.title)}`
    : raw
  return { type: 'text', text }
}

/** Lets the pointer place the caret while blocking anchor navigation. */
export function preventLinkNavigation(view: EditorView, event: MouseEvent) {
  const target = event.target
  if (!view.editable || !(target instanceof Element)) return false
  if (!target.closest('a[href]')) return false
  event.preventDefault()
  return true
}
