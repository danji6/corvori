/// <reference types="bun-types" />
import { replyTargetFor } from '@/lib/chat/reply-target-store'
import { buildRows, findPartRow } from '@/lib/chat/rows'
import type { MessageRecord } from '@/lib/chat/types'
import type { Id } from '@cv/convex/_generated/dataModel'
import {
  forgetQuotedMessage,
  quoteMessage,
  remapReplyQuote,
} from '@cv/convex/model/chat/replies'
import {
  REPLY_QUOTE_MAX_CHARS,
  clipReplyQuote,
  quotableText,
} from '@cv/core/reply-quote'
import { describe, expect, test } from 'bun:test'
import { lifecycleDatabase } from '~/tests/helpers/lifecycle-db'

const SESSION = 'session_1' as Id<'sessions'>
const sender = { type: 'user', id: 'user_1' }

const text = (value: string) => ({ type: 'text' as const, text: value })
const tool = { type: 'tool-shell', toolCallId: 'call_1' }

describe('quotableText', () => {
  test('quotes an agent turn by its final answer', () => {
    const parts = [text('Looking into it.'), tool, text(' Fixed the bug. ')]

    expect(quotableText(parts, true)).toBe('Fixed the bug.')
  })

  test('quotes other messages from their start', () => {
    const parts = [{ type: 'file' }, text('First'), text('Second')]

    expect(quotableText(parts, false)).toBe('First\n\nSecond')
  })

  test('is empty for a message without text', () => {
    expect(quotableText([{ type: 'file' }, text('  ')], false)).toBe('')
  })
})

describe('clipReplyQuote', () => {
  test('keeps a long excerpt within the limit without splitting an emoji', () => {
    const long = `${'a'.repeat(REPLY_QUOTE_MAX_CHARS - 2)}😀 tail`
    const clipped = clipReplyQuote(long)

    expect(clipped.length).toBeLessThanOrEqual(REPLY_QUOTE_MAX_CHARS)
    expect(clipped.endsWith('a…')).toBe(true)
  })
})

describe('reply block selection', () => {
  const step = { type: 'step-start' as const }
  const shell = (toolCallId: string) => ({
    type: 'tool-shell' as const,
    toolCallId,
    state: 'output-available' as const,
    input: { command: 'pwd' },
    output: '/workspace',
  })
  const firstParts = [
    text('First step'),
    step,
    shell('call_1'),
    shell('call_2'),
    text('Second step'),
  ]
  const lastParts = [text('Final answer')]
  const messageId = 'message_1' as Id<'messages'>
  const message = {
    id: messageId,
    role: 'assistant' as const,
    parts: [...firstParts, ...lastParts],
  }
  const record = {
    _creationTime: 1,
    sender: { type: 'agent', id: 'agent_1' },
    senderName: 'Agent',
    segments: [
      { index: 3, partCount: firstParts.length, sizeBytes: 1 },
      { index: 7, partCount: lastParts.length, sizeBytes: 1 },
    ],
  } as MessageRecord

  function database() {
    return lifecycleDatabase({
      messages: [
        {
          _id: messageId,
          _creationTime: 1,
          sessionId: SESSION,
          sender: record.sender,
          senderName: record.senderName,
          role: message.role,
          status: 'done',
          selectedVersion: 2,
        },
      ],
      messageContents: [
        {
          _id: 'old',
          messageId,
          version: 1,
          segmentIndex: 3,
          parts: [text('Old answer')],
        },
        {
          _id: 'first',
          messageId,
          version: 2,
          segmentIndex: 3,
          parts: firstParts,
        },
        {
          _id: 'last',
          messageId,
          version: 2,
          segmentIndex: 7,
          parts: lastParts,
        },
      ],
    })
  }

  test('successive replies quote their selected text blocks, including across segments', async () => {
    const { ctx } = database()
    const selections = [
      {
        scope: { segmentIndex: 3, groupIndex: 0 },
        partIndex: 0,
        text: 'First step',
      },
      {
        scope: { segmentIndex: 3, groupIndex: 3 },
        partIndex: 4,
        text: 'Second step',
      },
      {
        scope: { segmentIndex: 7, groupIndex: 0 },
        partIndex: 0,
        text: 'Final answer',
      },
    ]
    const quotes = []

    for (const { scope, partIndex, text: expected } of selections) {
      const target = replyTargetFor(message, record, scope)
      if (!target) throw new Error('Text block should be available for replies')
      expect(target.target.part).toEqual({
        segmentIndex: scope.segmentIndex,
        partIndex,
      })
      expect(target.text).toBe(expected)
      const quote = await quoteMessage(
        ctx,
        SESSION,
        messageId,
        target.target.part,
      )
      expect(quote.text).toBe(target.text)
      expect(quote.target?.part).toEqual(target.target.part)
      const rows = buildRows(
        [messageId],
        () => message,
        () => record,
      )
      expect(
        findPartRow(rows, message, record, quote.target!.part!),
      ).toMatchObject({
        kind: 'group',
        messageId,
        ...scope,
      })
      quotes.push(quote)
    }

    expect(quotes.map((quote) => quote.text)).toEqual(
      selections.map((item) => item.text),
    )
  })

  test('does not fall back to message text without a selected text block', () => {
    expect(replyTargetFor(message, record)).toBeUndefined()
    expect(replyTargetFor(message, record, null)).toBeUndefined()
    expect(
      replyTargetFor(message, record, { segmentIndex: 3, groupIndex: 2 }),
    ).toBeUndefined()
    expect(
      replyTargetFor(message, record, { segmentIndex: 4, groupIndex: 0 }),
    ).toBeUndefined()
  })

  test.each([
    { type: 'reasoning' as const, text: 'Thinking' },
    { type: 'file' as const, mediaType: 'image/png', url: '/image.png' },
    { ...shell('call_3'), type: 'tool-other' as const },
    text('  '),
  ])('does not offer replies on a $type block beside text', (part) => {
    const mixed = { ...message, parts: [part, text('Unrelated answer')] }
    const mixedRecord = { ...record, segments: [] }
    expect(
      replyTargetFor(mixed, mixedRecord, { segmentIndex: 0, groupIndex: 0 }),
    ).toBeUndefined()
  })

  test('does not jump to another loaded segment with the same part index', () => {
    const loadedMessage = { ...message, parts: lastParts }
    const loadedRecord = { ...record, segments: record.segments.slice(1) }
    const rows = buildRows(
      [messageId],
      () => loadedMessage,
      () => loadedRecord,
    )

    expect(
      findPartRow(rows, loadedMessage, loadedRecord, {
        segmentIndex: 3,
        partIndex: 0,
      }),
    ).toBeUndefined()
  })

  test('remaps the quoted block when a copied message has different segments', async () => {
    const { ctx, rows } = database()
    const copyId = 'message_copy' as Id<'messages'>
    rows('messages').push({ _id: copyId, _creationTime: 2, selectedVersion: 1 })
    rows('messageContents').push({
      _id: 'copy',
      messageId: copyId,
      version: 1,
      segmentIndex: 0,
      parts: message.parts,
    })
    const quote = await quoteMessage(ctx, SESSION, messageId, {
      segmentIndex: 7,
      partIndex: 0,
    })

    const copy = await remapReplyQuote(
      ctx,
      quote,
      new Map([[messageId, copyId]]),
    )

    expect(copy).toMatchObject({
      text: 'Final answer',
      target: {
        id: copyId,
        creationTime: 2,
        part: { segmentIndex: 0, partIndex: firstParts.length },
      },
    })
  })

  test.each([
    { segmentIndex: 3, partIndex: 1 },
    { segmentIndex: 4, partIndex: 0 },
    { segmentIndex: 3, partIndex: 0.5 },
  ])(
    'rejects missing or non-text selections instead of quoting another block (%j)',
    async (part) => {
      const { ctx } = database()
      await expect(
        quoteMessage(ctx, SESSION, messageId, part),
      ).rejects.toThrow()
    },
  )
})

describe('quoteMessage', () => {
  const message = (overrides: Record<string, unknown>) => ({
    _id: 'message_1',
    _creationTime: 1,
    sessionId: SESSION,
    sender,
    role: 'user',
    status: 'done',
    selectedVersion: 1,
    ...overrides,
  })

  const quote = (row: ReturnType<typeof message>) => {
    const { ctx } = lifecycleDatabase({ messages: [row] })
    return quoteMessage(ctx, SESSION, row._id as Id<'messages'>)
  }

  test('rejects messages from another session', async () => {
    await expect(quote(message({ sessionId: 'session_2' }))).rejects.toThrow()
  })

  test('rejects notes, notices and unsettled messages', async () => {
    const unquotable = [
      message({ type: 'presence' }),
      message({ hidden: true }),
      message({ status: 'processing' }),
    ]

    for (const row of unquotable) {
      await expect(quote(row)).rejects.toThrow()
    }
  })
})

describe('forgetQuotedMessage', () => {
  test('detaches only the replies quoting the deleted message', async () => {
    const reply = (id: string, targetId: string) => ({
      _id: id,
      replyTo: {
        target: { id: targetId, creationTime: 1 },
        sender,
        senderName: 'Alice',
        text: 'quoted',
      },
    })
    const { ctx, rows } = lifecycleDatabase({
      messages: [reply('reply_1', 'deleted'), reply('reply_2', 'kept')],
    })

    await forgetQuotedMessage(ctx, 'deleted' as Id<'messages'>)

    expect(rows('messages')[0].replyTo).toEqual({
      sender,
      senderName: 'Alice',
      text: '',
    })
    expect(rows('messages')[1].replyTo).toMatchObject({
      target: { id: 'kept' },
      text: 'quoted',
    })
  })
})
