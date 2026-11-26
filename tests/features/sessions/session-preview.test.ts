import type { Id } from '@cv/convex/_generated/dataModel'
import {
  deleteMessage,
  deleteMessageParts,
} from '@cv/convex/model/chat/mutations'
import { messagePreview, syncActivity } from '@cv/convex/model/messages'
import { expect, test } from 'bun:test'
import { skillsDatabase } from '~/tests/helpers/skills-db'

test('session activity stores readable previews from the original text parts', async () => {
  const { ctx, rows } = skillsDatabase()
  const sessionId = 'session' as Id<'sessions'>
  rows('sessions').push({ _id: sessionId })

  await syncActivity(ctx, sessionId, [
    { type: 'text', text: `\`\`\`ts\n${'code\n'.repeat(40)}\`\`\`` },
    { type: 'reasoning', text: 'Ignore this.' },
    {
      type: 'text',
      text: '# **Move** the `task` tool\n\n> See [details](https://example.com).',
    },
  ])
  await syncActivity(ctx, sessionId, [
    { type: 'text', text: '*The changes are ready.*\n- [x] Tests passed' },
  ])

  expect(await ctx.db.get(sessionId)).toMatchObject({
    firstMessagePreview: 'Move the task tool See details.',
    lastMessagePreview: 'The changes are ready. Tests passed',
  })
})

test('code-only previews keep the code and omit the fence', () => {
  expect(
    messagePreview([{ type: 'text', text: '~~~sh\nprintf "%s" foo_bar\n~~~' }]),
  ).toBe('printf "%s" foo_bar')
})

test('deleting the latest message restores the previous visible preview and clears it when empty', async () => {
  const { ctx, rows } = skillsDatabase({
    by_messageId_version_segment: ['segmentIndex'],
  })
  const sessionId = 'session' as Id<'sessions'>
  rows('sessions').push({ _id: sessionId, ownerId: ctx.userId })
  rows('userSessions').push({
    _id: 'member',
    sessionId,
    userId: ctx.userId,
    role: 'owner',
    lastMessageAt: 10,
  })
  const previous = 'previous' as Id<'messages'>
  const latest = 'latest' as Id<'messages'>
  const messages = [
    [previous, ['**First segment.**', 'Second segment.'], false],
    ['note', ['Internal context'], true],
    [latest, ['Delete me'], false],
  ] as const
  for (const [index, [id, parts, hidden]] of messages.entries()) {
    rows('messages').push({
      _id: String(id),
      sessionId,
      position: String(index),
      selectedVersion: 2,
      sender: { type: 'agent', id: 'agent' },
      role: 'assistant',
      status: 'done',
      hidden,
    })
    for (const [segmentIndex, text] of parts.entries()) {
      rows('messageContents').push({
        _id: `${id}-${segmentIndex}`,
        messageId: id,
        version: 2,
        segmentIndex,
        parts: [{ type: 'text', text }],
      })
    }
  }
  rows('messageContents').push({
    _id: 'old-version',
    messageId: previous,
    version: 1,
    segmentIndex: 0,
    parts: [{ type: 'text', text: 'Unselected version' }],
  })
  await ctx.db.patch(sessionId, {
    firstMessagePreview: 'First segment. Second segment.',
    lastMessagePreview: 'Delete me',
    lastMessageAt: 10,
  })

  await deleteMessage(ctx, { messageId: latest })
  expect(await ctx.db.get(sessionId)).toMatchObject({
    lastMessagePreview: 'First segment. Second segment.',
    lastMessageAt: 10,
  })
  expect(rows('userSessions')[0].lastMessageAt).toBe(10)

  const deleted = await deleteMessageParts(ctx, {
    messageId: previous,
    addresses: [],
    from: { segmentIndex: 0, partIndex: 0 },
  })
  expect(deleted).toBe(true)
  expect(await ctx.db.get(sessionId)).toMatchObject({
    firstMessagePreview: undefined,
    lastMessagePreview: undefined,
  })
})
