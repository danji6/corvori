/// <reference types="bun-types" />
import {
  type PartGroup,
  fromAddressForGroup,
  groupPartAddresses,
  groupParts,
} from '@/lib/chat/parts'
import type { Doc, Id } from '@cv/convex/_generated/dataModel'
import type { Role } from '@cv/convex/lib/roles'
import { assertRangeDeletable, deleteMessagesFrom } from '@cv/convex/model/chat'
import { messagePosition } from '@cv/core/message-position'
import type { UIMessage } from 'ai'
import { describe, expect, test } from 'bun:test'
import { skillsDatabase } from '~/tests/helpers/skills-db'

type Message = Doc<'messages'>
type Session = Doc<'sessions'>

function message(overrides: Partial<Message>): Message {
  return {
    status: 'done',
    sender: { type: 'agent', id: 'agent-1' },
    ...overrides,
  } as Message
}

function userMessage(userId: string, overrides: Partial<Message> = {}) {
  return message({
    sender: { type: 'user', id: userId } as Message['sender'],
    ...overrides,
  })
}

function caller(userId: string, role: Role) {
  return { userId: userId as Id<'users'>, role }
}

const session = { ownerId: 'owner-1' } as Session

describe('assertRangeDeletable', () => {
  test('allows agent messages and own user messages', () => {
    const range = [message({}), userMessage('member-1'), message({})]

    expect(() =>
      assertRangeDeletable(caller('member-1', 'user'), range, session),
    ).not.toThrow()
  })

  test('rejects the whole range when it contains another user message', () => {
    const range = [
      userMessage('member-1'),
      userMessage('member-2'),
      message({}),
    ]

    expect(() =>
      assertRangeDeletable(caller('member-1', 'user'), range, session),
    ).toThrow()
  })

  test('lets the session owner delete other user messages', () => {
    const range = [userMessage('member-1'), userMessage('member-2')]

    expect(() =>
      assertRangeDeletable(caller('owner-1', 'user'), range, session),
    ).not.toThrow()
  })

  test('lets a moderator delete other user messages', () => {
    const range = [userMessage('member-1'), userMessage('member-2')]

    expect(() =>
      assertRangeDeletable(caller('member-3', 'moderator'), range, session),
    ).not.toThrow()
  })

  test('reserves join/leave notices for the owner and moderators', () => {
    const ownJoin = userMessage('member-1', { type: 'presence' })
    const agentJoin = message({ type: 'presence' })

    for (const notice of [ownJoin, agentJoin]) {
      expect(() =>
        assertRangeDeletable(caller('member-1', 'user'), [notice], session),
      ).toThrow()
      expect(() =>
        assertRangeDeletable(caller('owner-1', 'user'), [notice], session),
      ).not.toThrow()
      expect(
        () =>
        assertRangeDeletable(caller('member-3', 'moderator'), [notice], session), // prettier-ignore
      ).not.toThrow()
    }
  })

  test('rejects a range containing a processing message', () => {
    const range = [message({}), message({ status: 'processing' })]

    expect(() =>
      assertRangeDeletable(caller('owner-1', 'admin'), range, session),
    ).toThrow()
  })
})

test('deletes from the position of an anchored note in the transcript', async () => {
  const { ctx, db, rows } = skillsDatabase()
  const sessionId = await db.insert('sessions', { ownerId: ctx.userId })
  await db.insert('userSessions', {
    sessionId,
    userId: ctx.userId,
    role: 'owner',
  })
  const ids = []
  for (const time of [1, 2, 3, 4]) {
    const _id = await db.insert('messages', {
      ...message({ _creationTime: time }),
      sessionId,
    })
    ids.push(_id)
    await db.patch(_id, {
      position: messagePosition({ _id, _creationTime: time }),
    })
  }
  const [earlier, anchor, intervening, note] = ids
  const position = messagePosition(
    { _id: note, _creationTime: 4 },
    { anchor: { _id: anchor, _creationTime: 2 }, kind: 'contextNote' },
  )
  await db.patch(note, { position, type: 'workspace', hidden: true })
  await deleteMessagesFrom(ctx, { messageId: note as Id<'messages'> })
  expect(rows('messages').map((row) => row._id)).toEqual([earlier])
  expect(await db.get(intervening)).toBeNull()
})

const text = (text: string) => ({ type: 'text', text })
const read = (id: string) => ({
  type: 'tool-read_file',
  toolCallId: id,
  state: 'output-available',
})
const step = { type: 'step-start' }

function partsOf(...parts: object[]): UIMessage['parts'] {
  return parts as UIMessage['parts']
}

function groupAt(parts: UIMessage['parts'], index: number): PartGroup {
  const group = groupParts(parts)[index]
  if (!group) throw new Error(`no group at ${index}`)
  return group
}

describe('part addresses', () => {
  test('addresses a group of parts within its segment', () => {
    const parts = partsOf(text('a'), read('1'), step, read('2'), text('b'))

    expect(groupPartAddresses(2, parts, groupAt(parts, 1))).toEqual([
      { segmentIndex: 2, partIndex: 1 },
      { segmentIndex: 2, partIndex: 3 },
    ])
  })

  test('addresses a single group by its intra-segment index', () => {
    const parts = partsOf(text('a'), text('b'), text('c'))

    expect(groupPartAddresses(0, parts, groupAt(parts, 1))).toEqual([
      { segmentIndex: 0, partIndex: 1 },
    ])
  })

  test('fromAddressForGroup points at the group start', () => {
    const parts = partsOf(text('a'), read('1'), step, read('2'), text('b'))

    expect(fromAddressForGroup(1, groupAt(parts, 1))).toEqual({
      segmentIndex: 1,
      partIndex: 1,
    })
    expect(fromAddressForGroup(0, groupAt(parts, 2))).toEqual({
      segmentIndex: 0,
      partIndex: 4,
    })
  })
})
