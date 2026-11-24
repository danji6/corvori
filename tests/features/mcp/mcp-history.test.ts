import type { Id } from '@cv/convex/_generated/dataModel'
import { _getProviderHistory } from '@cv/convex/model/stream/reads'
import { expect, test } from 'bun:test'
import { skillRequests } from '~/tests/helpers/skill-requests'
import { skillsDatabase } from '~/tests/helpers/skills-db'

test('current MCP guidance crosses the frozen history boundary and other agents guidance stays scoped', async () => {
  const f = skillsDatabase()
  for (const [id, agent, time] of [
    ['own', 'agent-one', 6],
    ['other', 'agent-two', 7],
    ['current', 'agent-one', 20],
  ] as const) {
    await f.db.insert('messages', {
      _id: id,
      sessionId: 'session',
      _creationTime: time,
      role: 'system',
      sender: { type: 'agent', id: agent },
      status: 'done',
      contextEligible: true,
      hidden: true,
      type: 'mcp',
      ...(id === 'current' && {
        extra: { anchorMessageId: 'output', anchorPartCount: 0 },
      }),
      selectedVersion: 1,
    })
    await f.db.insert('messageContents', {
      messageId: id,
      version: 1,
      segmentIndex: 0,
      parts: [{ type: 'text', text: `Guidance for ${agent}` }],
    })
  }
  const streamId = (await f.db.insert('streams', {
    agentId: 'agent-one',
    sessionId: 'session',
    generation: 1,
    contextBoundaryCreationTime: 10,
    command: { kind: 'invoke' },
    state: { phase: 'streaming', processingMessageId: 'output' },
  })) as Id<'streams'>
  const history = await _getProviderHistory(f.ctx, { streamId, generation: 1 })
  expect(history.map((message) => String(message._id))).toEqual([
    'own',
    'current',
  ])
  expect(history[1].parts).toEqual([
    { type: 'text', text: 'Guidance for agent-one' },
  ])
})

test('a fresh session with a direct MCP tool omits the catalog note until broker access is enabled', async () => {
  const f = skillRequests('/unused')
  try {
    await f.db.patch('session', { folderId: undefined, title: 'Fixture' })
    f.rows('mcpServers').push({
      _id: 'web',
      ownerId: 'owner',
      key: 'web',
      label: 'web',
      transport: 'http',
      url: 'http://fixture',
      enabled: true,
    })
    await f.db.insert('mcpTools', {
      serverId: 'web',
      name: 'fetch_js',
      inputSchema: '{"type":"object"}',
      order: 0,
    })
    f.agent.tools = ['web_fetch_js']
    const direct = (await f.nextTurn())!
    expect(direct.toolRuntime!.frozen.names).toEqual([
      'web_fetch_js',
      'get_tool',
      'call_tool',
    ])
    const mcpNotes = () =>
      f.rows('messages').filter((row) => row.type === 'mcp')
    expect(mcpNotes()).toHaveLength(0)

    f.agent.tools.push('mcp_access')
    const brokered = (await f.repeat())!
    expect(brokered.toolRuntime!.current.names).toContain('search_mcp_tools')
    expect(mcpNotes()).toHaveLength(1)
    const note = f
      .rows('messageContents')
      .find((row) => row.messageId === mcpNotes()[0]._id)
    expect(JSON.stringify(note?.parts)).toContain('MCP server catalog')
    expect(JSON.stringify(note?.parts)).not.toMatch(
      /search_mcp_tools|call_mcp_tool|mcp_protocol/,
    )
  } finally {
    f.restore()
  }
})
