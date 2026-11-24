import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { visit } from 'unist-util-visit'

const parser = unified().use(remarkParse).use(remarkGfm).freeze()

export type MarkdownLink = { url: string; start: number; end: number }

export function linkPreviewUrls(text: string): string[] {
  const urls = markdownHttpLinks(text).map(({ url }) => url)
  return [...new Set(urls)].slice(0, 4)
}

/** Finds explicit links and plain HTTP URLs while skipping Markdown code. */
export function markdownHttpLinks(markdown: string): MarkdownLink[] {
  const links: MarkdownLink[] = []
  if (!/https?:\/\//i.test(markdown)) return links

  visit(parser.parse(markdown), (node) => {
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    if (start === undefined || end === undefined) return

    if (node.type === 'link' || node.type === 'image') {
      if (/^https?:\/\//i.test(node.url)) {
        links.push({ url: node.url, start, end })
      }
      return 'skip'
    }

    if (node.type === 'text') {
      // GFM does not autolink hosts such as localhost.
      const source = markdown.slice(start, end)
      for (const match of source.matchAll(/https?:\/\/[^\s<>"'\x60]+/gi)) {
        const url = match[0].replace(/[),.!?:;]+$/, '')
        const offset = start + match.index
        links.push({ url, start: offset, end: offset + url.length })
      }
    }
  })

  return links
}

/** Removes links in source order while preserving the rest of the Markdown. */
export function removeMarkdownLinks(content: string, links: MarkdownLink[]) {
  let text = ''
  let offset = 0
  for (const { start, end } of links) {
    text += content.slice(offset, start)
    offset = end
    if (!text || /\s$/.test(text)) {
      offset += /^[ \t]*/.exec(content.slice(end))![0].length
    }
  }
  return text + content.slice(offset)
}
