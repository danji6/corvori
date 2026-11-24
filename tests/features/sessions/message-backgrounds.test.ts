import { messageBackgroundRanges } from '@/lib/chat/message-backgrounds'
import { projectNoteRows } from '@/lib/chat/note-rows'
import { buildRows } from '@/lib/chat/rows'
import type { MessageRecord } from '@/lib/chat/types'
import { expect, test } from 'bun:test'

function transcript(groupBySender: boolean) {
  const ids = [
    'first',
    'note1',
    'note2',
    'second',
    'third',
    'other',
    'summary',
    'reset',
    'last',
  ]
  return buildRows(
    ids,
    (id) => ({
      id,
      role: 'assistant',
      parts: [{ type: 'text', text: id }],
    }),
    (id) =>
      ({
        sender: { type: 'agent', id: id === 'other' ? 'other-agent' : 'agent' },
        hidden: id.startsWith('note') || id === 'reset',
        type:
          id === 'summary'
            ? 'summary'
            : id === 'reset'
              ? 'contextReset'
              : undefined,
        hasChanges: id === 'first' || id === 'summary',
      }) as MessageRecord,
    undefined,
    { groupBySender },
  )
}

test.each([false, true])(
  'breaks at notes without changing the sender palette (expanded=%s)',
  (expanded) => {
    const rows = projectNoteRows(
      transcript(true),
      new Set(expanded ? ['notes:note1'] : []),
    )
    const ranges = messageBackgroundRanges(rows)
    expect(ranges.map(({ paletteMessageId }) => paletteMessageId)).toEqual([
      'first',
      'first',
      'other',
      'last',
    ])
    expect(
      ranges.map(({ first, last }) =>
        rows.slice(first, last + 1).map((row) => row.messageId),
      ),
    ).toEqual([
      ['first', 'first', 'first'],
      ['second', 'third'],
      ['other', 'other'],
      ['last', 'last'],
    ])
    expect(rows[ranges[0]!.last]!.key).toBe('f:first')
    expect(rows.some((row) => row.key === 'f:summary')).toBe(false)
  },
)

test('uses separate surfaces for repeated headers when grouping is off', () => {
  const rows = projectNoteRows(transcript(false), new Set(['notes:note1']))
  const ranges = messageBackgroundRanges(rows)
  expect(ranges.map(({ paletteMessageId }) => paletteMessageId)).toEqual([
    'first',
    'second',
    'third',
    'other',
    'last',
  ])
})
