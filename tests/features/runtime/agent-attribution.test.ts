import type { Doc, Id } from '@cv/convex/_generated/dataModel'
import { quoteMessage } from '@cv/convex/model/chat/replies'
import { insertMessage, withParts } from '@cv/convex/model/messageContents'
import { updateProfile } from '@cv/convex/model/session/authorProfiles'
import {
  buildProviderHistory,
  insertReplyQuote,
  prefixSenderName,
  representMessage,
} from '@cv/convex/model/stream/history'
import type { UIMessage } from 'ai'
import { describe, expect, test } from 'bun:test'
import {
  OTHER,
  SELF,
  USER,
  agent,
  note,
  stored,
  textAndToolParts,
} from '~/tests/helpers/provider-history'
import { skillsDatabase } from '~/tests/helpers/skills-db'

describe('representMessage', () => {
  test('keeps own assistant turn untouched', () => {
    const msg = stored({ type: 'agent', id: SELF }, 'assistant')
    const result = representMessage(msg, agent({ maskOtherAgents: true }), [
      ...textAndToolParts,
    ])
    expect(result.role).toBe('assistant')
    expect(result.parts).toHaveLength(3)
  })

  test('masks other agent as a user turn and strips non-text/file parts', () => {
    const msg = stored({ type: 'agent', id: OTHER }, 'assistant')
    const result = representMessage(msg, agent({ maskOtherAgents: true }), [
      ...textAndToolParts,
    ])
    expect(result.role).toBe('user')
    expect(result.parts).toEqual([{ type: 'text', text: 'hello' }])
  })

  test('leaves other agent as assistant when masking is off', () => {
    const msg = stored({ type: 'agent', id: OTHER }, 'assistant')
    const result = representMessage(msg, agent({ maskOtherAgents: false }), [
      ...textAndToolParts,
    ])
    expect(result.role).toBe('assistant')
    expect(result.parts).toHaveLength(3)
  })

  test('user turns keep their role but drop non-text/file parts', () => {
    const msg = stored({ type: 'user', id: USER }, 'user')
    const result = representMessage(msg, agent({ maskOtherAgents: true }), [
      ...textAndToolParts,
    ])
    expect(result.role).toBe('user')
    expect(result.parts).toEqual([{ type: 'text', text: 'hello' }])
  })

  test('keeps an injected note authored by another agent as system', () => {
    const msg = note({ type: 'agent', id: OTHER }, 'system')
    const result = representMessage(msg, agent({ maskOtherAgents: true }), [
      {
        type: 'text',
        text: '<system-reminder>\nstay on task\n</system-reminder>',
      },
    ])
    expect(result.role).toBe('system')
    expect(result.parts).toEqual([
      {
        type: 'text',
        text: '<system-reminder>\nstay on task\n</system-reminder>',
      },
    ])
  })

  test('a note authored with the user role still reads as a user turn', () => {
    const msg = note({ type: 'agent', id: OTHER }, 'user')
    const result = representMessage(msg, agent({ maskOtherAgents: true }), [
      ...textAndToolParts,
    ])
    expect(result.role).toBe('user')
    expect(result.parts).toEqual([{ type: 'text', text: 'hello' }])
  })
})

describe('prefixSenderName', () => {
  const message = (): UIMessage => ({
    id: 'm1',
    role: 'user',
    parts: [{ type: 'text', text: 'hi' }],
  })

  function textOf(parts: UIMessage['parts']) {
    const part = parts.find((p) => p.type === 'text')
    return part && part.type === 'text' ? part.text : undefined
  }

  test('prefixes user name only when shareUserDisplayNames is on', () => {
    const msg = stored({ type: 'user', id: USER }, 'user', 'Alice')
    expect(textOf(prefixSenderName(message(), msg, agent()))).toBe('hi')
    expect(
      textOf(
        prefixSenderName(
          message(),
          msg,
          agent({ shareUserDisplayNames: true }),
        ),
      ),
    ).toBe('Alice: hi')
  })

  test('prefixes other agent name only when shareAgentDisplayNames is on', () => {
    const msg = stored({ type: 'agent', id: OTHER }, 'assistant', 'Bot')
    expect(textOf(prefixSenderName(message(), msg, agent()))).toBe('hi')
    expect(
      textOf(
        prefixSenderName(
          message(),
          msg,
          agent({ shareAgentDisplayNames: true }),
        ),
      ),
    ).toBe('Bot: hi')
  })

  test('attributes literal reply markup to its sender', () => {
    const msg = stored({ type: 'agent', id: OTHER }, 'assistant', 'Bot')
    const literal = '<reply to="Alice">example</reply>'
    const content = message()
    content.parts = [
      { type: 'text', text: literal },
      { type: 'text', text: 'More text.' },
    ]

    const parts = prefixSenderName(
      content,
      msg,
      agent({ shareAgentDisplayNames: true }),
    )

    expect(parts).toEqual([
      { type: 'text', text: `Bot: ${literal}` },
      { type: 'text', text: 'More text.' },
    ])
  })

  test('never prefixes the agent itself', () => {
    const msg = stored({ type: 'agent', id: SELF }, 'assistant', 'Bot')
    expect(
      textOf(
        prefixSenderName(
          message(),
          msg,
          agent({ shareAgentDisplayNames: true }),
        ),
      ),
    ).toBe('hi')
  })

  test('never attributes an injected note to the agent that wrote it', () => {
    const msg = {
      ...note({ type: 'agent', id: OTHER }, 'system'),
      senderName: 'Bot',
    }
    expect(
      textOf(
        prefixSenderName(
          message(),
          msg,
          agent({ shareAgentDisplayNames: true }),
        ),
      ),
    ).toBe('hi')
  })

  test('never attributes a command chip to the user who ran it', () => {
    const msg = {
      ...note({ type: 'user', id: USER }, 'user', 'command'),
      senderName: 'Alice',
    }
    expect(
      textOf(
        prefixSenderName(
          message(),
          msg,
          agent({ shareUserDisplayNames: true }),
        ),
      ),
    ).toBe('hi')
  })
})

describe('insertReplyQuote', () => {
  const reply = (
    quoted: Doc<'messages'>['sender'],
    text = 'the answer',
    senderName: string | null = 'Quoted',
  ): Doc<'messages'> => ({
    ...stored({ type: 'user', id: USER }, 'user'),
    replyTo: { sender: quoted, senderName, text },
  })

  const message = (): UIMessage => ({
    id: 'm1',
    role: 'user',
    parts: [
      { type: 'text', text: '<file path="a.ts">\ncode\n</file>' },
      { type: 'text', text: 'Alice: why?' },
    ],
  })

  const texts = (parts: UIMessage['parts']) =>
    parts.map((part) => (part.type === 'text' ? part.text : ''))

  test('puts the quote right before the reply text', () => {
    const parts = insertReplyQuote(
      message(),
      reply({ type: 'agent', id: SELF }),
    )

    expect(texts(parts)).toEqual([
      '<file path="a.ts">\ncode\n</file>',
      '<reply to="Quoted">\nthe answer\n</reply>',
      'Alice: why?',
    ])
  })

  test('inserts the quote before literal reply markup with names off', () => {
    const content = message()
    const literal = '<reply to="Alice">example</reply>'
    content.parts[1] = { type: 'text', text: literal }

    const parts = insertReplyQuote(content, reply({ type: 'agent', id: OTHER }))

    expect(texts(parts)).toEqual([
      '<file path="a.ts">\ncode\n</file>',
      '<reply to="Quoted">\nthe answer\n</reply>',
      literal,
    ])
  })

  test.each([
    { type: 'user' as const, id: USER },
    { type: 'agent' as const, id: OTHER },
    { type: 'agent' as const, id: SELF },
  ])('always names the quoted sender (%j)', (sender) => {
    const parts = insertReplyQuote(message(), reply(sender))

    expect(texts(parts)[1]).toBe('<reply to="Quoted">\nthe answer\n</reply>')
  })

  test('uses the display name fallback when the original has no name', () => {
    const quoted = reply({ type: 'user', id: USER }, 'the answer', null)

    expect(texts(insertReplyQuote(message(), quoted))[1]).toBe(
      '<reply to="Anonymous">\nthe answer\n</reply>',
    )
  })

  test('adds nothing once the quoted message is gone', () => {
    const detached = reply({ type: 'user', id: USER }, '')

    expect(insertReplyQuote(message(), detached)).toHaveLength(2)
  })
})

test('keeps old provider history and the frozen prompt across a profile rename', async () => {
  const { ctx, rows } = skillsDatabase()
  const sessionId = 'session' as Id<'sessions'>
  const sender = { type: 'user', id: ctx.userId } as const
  rows('sessions').push({ _id: sessionId, ownerId: ctx.userId })
  rows('userSessions').push({ _id: 'owner', sessionId, userId: ctx.userId })
  const cache = {
    _id: 'cache',
    sessionId,
    agentId: SELF,
    promptEvaluationId: 'frozen',
  }
  rows('sessionCache').push(cache)
  rows('sessionProfiles').push({
    _id: 'override',
    sessionId,
    sender,
    name: 'First name',
  })
  const fields = { sessionId, sender, role: 'user', status: 'done' } as const
  const send = async (text: string, replyTo?: Doc<'messages'>['replyTo']) => {
    const { messageId } = await insertMessage(ctx, { ...fields, replyTo }, [
      { type: 'text', text },
    ])
    return withParts(ctx, (await ctx.db.get(messageId))!)
  }
  const first = await send('hello')
  const oldQuote = await quoteMessage(ctx, sessionId, first._id)
  const reply = await send('old reply', oldQuote)
  const stream = {
    sessionId,
    state: { phase: 'streaming', processingMessageId: 'output' },
  }
  const history = (
    historyRows: (typeof first)[],
    shareUserDisplayNames = true,
  ) =>
    buildProviderHistory(
      {} as never,
      { agent: agent({ shareUserDisplayNames }), stream } as never,
      [],
      { historyRows },
    )

  const original = await history([first, reply])
  expect(JSON.stringify(original)).toContain('First name: hello')
  await updateProfile(ctx, { sessionId, sender, name: 'Current name' })
  expect(rows('sessionCache')).toHaveLength(1)
  expect(rows('sessionCache')[0].promptEvaluationId).toBe('frozen')
  expect(await history([first, reply])).toEqual(original)

  const newQuote = await quoteMessage(ctx, sessionId, first._id)
  expect(newQuote).toEqual(oldQuote)
  const newReply = await send('new reply', newQuote)
  const updated = JSON.stringify(await history([first, reply, newReply]))
  expect(updated).toContain('Current name: new reply')
  const privateHistory = JSON.stringify(await history([first, newReply], false))
  expect(privateHistory).toContain('First name')
  expect(privateHistory).not.toContain('Current name')
})
