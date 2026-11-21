/// <reference types="bun-types" />
import { AttachmentAnchor } from '@/components/markdown/attachment-anchor'
import { attachmentUrlTransform } from '@/lib/markdown/attachment-link'
import { sanitizeSchema } from '@/lib/markdown/sanitize'
import http from '@cv/convex/http'
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import Markdown from 'react-markdown'
import rehypeSanitize from 'rehype-sanitize'

const render = (content: string) =>
  renderToStaticMarkup(
    <Markdown
      components={{
        a: ({ href, ...props }) =>
          href ? <AttachmentAnchor href={href} {...props} /> : null,
      }}
      rehypePlugins={[[rehypeSanitize, sanitizeSchema]]}
      urlTransform={attachmentUrlTransform}
    >
      {content}
    </Markdown>,
  )

describe('attachment markdown links', () => {
  test('renders a reference label while its authenticated URL is unavailable', () => {
    const html = render('[📎 notes.txt](attachment:token/notes.txt)')

    expect(html).not.toContain('href=')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('📎 notes.txt')
  })

  test('still filters unknown custom protocols', () => {
    const html = render('[unsafe](unknown:value)')

    expect(html).not.toContain('href="unknown:value"')
  })
})

test('the legacy bearer route has been removed', () => {
  expect(http.lookup('/attachments/token/notes.txt', 'GET')).toBeNull()
})
