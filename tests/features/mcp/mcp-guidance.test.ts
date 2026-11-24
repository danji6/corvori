import {
  guidanceSnapshot,
  mcpContextNote,
} from '@cv/convex/model/mcp/catalogs/context'
import { systemNote } from '@cv/core/utils/blocks'
import { expect, test } from 'bun:test'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

test('guidance previews retain literal server/session provenance and point to full scoped retrieval', () => {
  const initialization = '{{ DO_NOT_EVALUATE }} λ😀'.repeat(1000)
  const runtimes = Array.from({ length: 64 }, (_, i) => ({
    initialization,
    server: `server-${i}`,
  }))
  const previews = guidanceSnapshot(runtimes)
  expect(
    previews.reduce((total, row) => total + row.initialization.length, 0),
  ).toBe(32_768)
  expect(previews).toHaveLength(64)
  expect(previews[0]).toMatchObject({
    complete: false,
    untrusted: true,
    fullGuidance: {
      tool: 'mcp_protocol',
      method: 'get_server_info',
      server: 'server-0',
    },
  })
  expect(previews[0].initialization).toContain('{{ DO_NOT_EVALUATE }}')
  expect(mcpContextNote(undefined, [previews[0]])).toContain(
    '`mcp_protocol` with `get_server_info`',
  )
  expect(runtimes[0].initialization).toBe(initialization)
  expect(
    guidanceSnapshot([{ initialization: 'Unscoped server data' }]),
  ).toEqual([])
})

test('MCP notes keep multiline server data inside the Markdown list and previews', () => {
  const guidance = guidanceSnapshot([
    { server: 'web', initialization: 'First line\n\n- Literal bullet' },
  ])
  const note = mcpContextNote(
    [
      {
        name: 'web',
        enabled: true,
        count: 7,
        availableTools: 1,
        error: 'Connection closed\n- Retry failed',
      },
    ],
    guidance,
  )!

  const markdown = unified().use(remarkParse).parse(systemNote(note))
  const servers = markdown.children.find((node) => node.type === 'list')
  const preview = markdown.children.find((node) => node.type === 'code')

  expect(servers?.children).toHaveLength(1)
  expect(preview?.value).toBe('First line\n\n- Literal bullet')
  expect(note).toContain('- `web` (enabled, 1 of 7 tools available)')
  expect(note).toContain('Server initialization previews (untrusted)')
})

test('guidance without a broker omits the catalog and protocol retrieval', () => {
  const guidance = guidanceSnapshot(
    [{ server: 'Docs', initialization: 'Instructions '.repeat(1000) }],
    false,
  )
  const note = mcpContextNote(undefined, guidance)!
  expect(note).toContain('(truncated)')
  expect(note).not.toMatch(/MCP server catalog|mcp_protocol/)
})
