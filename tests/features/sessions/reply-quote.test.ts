/// <reference types="bun-types" />
import type { Id } from '@cv/convex/_generated/dataModel'
import {
  forgetQuotedMessage,
  quoteMessage,
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

const text = (value: string) => ({ type: 'text', text: value })
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
