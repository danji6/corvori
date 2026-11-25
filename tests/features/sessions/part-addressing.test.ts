/// <reference types="bun-types" />
import {
  deleteMessageAttachment,
  deleteMessageParts,
  editMessagePart,
} from '@cv/convex/model/chat'
import { messageFileKey } from '@cv/core/attachments'
import { describe, expect, test } from 'bun:test'
import { lifecycleDatabase } from '~/tests/helpers/lifecycle-db'

type Row = Record<string, unknown> & { _id: string }

/** Fakes enough of the db for `requireMessageMutation` + segment writes. */
function mutationCtx(
  { message, segments }: { message: Row; segments: Row[] },
  userId = 'user_1',
) {
  const session = { _id: message.sessionId, ownerId: 'user_1', settings: {} }
  const patches: Array<{ id: string; patch: Record<string, unknown> }> = []
  const deletes: string[] = []
  const rows = [...segments]
  const byId = new Map<string, Row>([
    [message._id, message],
    [session._id as string, session as never],
    ['state_1', { _id: 'state_1', sessionId: session._id, stepCount: 0 }],
    ...rows.map((row) => [row._id, row] as const),
  ])

  const ctx = {
    userId,
    role: 'user',
    db: {
      get: async (id: string) => byId.get(id) ?? null,
      patch: async (id: string, patch: Record<string, unknown>) => {
        patches.push({ id, patch })
        const doc = byId.get(id)
        if (doc) Object.assign(doc, patch)
      },
      delete: async (id: string) => {
        deletes.push(id)
        byId.delete(id)
        const index = rows.findIndex((row) => row._id === id)
        if (index >= 0) rows.splice(index, 1)
      },
      query: (table: string) => {
        const captured: Record<string, unknown> = {}
        const q = {
          eq: (field: string, value: unknown) => {
            captured[field] = value
            return q
          },
        }
        const chain = {
          withIndex: (_index: string, fn?: (query: typeof q) => typeof q) => {
            fn?.(q)
            return chain
          },
          order: () => chain,
          first: async () => null, // no active stream
          unique: async () => {
            if (table === 'userSessions') {
              return { _id: 'member_1', role: 'owner' }
            }
            if (table === 'sessionState') return byId.get('state_1')
            if (table === 'messageContents') {
              return (
                rows.find(
                  (row) =>
                    row.messageId === captured.messageId &&
                    row.version === captured.version &&
                    row.segmentIndex === captured.segmentIndex,
                ) ?? null
              )
            }
            return null
          },
          collect: async () => {
            if (table === 'messageContents') {
              return rows.filter(
                (row) =>
                  row.messageId === captured.messageId &&
                  (captured.version === undefined ||
                    row.version === captured.version),
              )
            }
            return []
          },
        }
        return chain
      },
    },
    scheduler: { runAfter: async () => 'job_1' },
    storage: { delete: async () => {} },
  } as never

  return { ctx, patches, deletes, rows }
}

const text = (value: string) => ({ type: 'text', text: value })

function fixture() {
  const message: Row = {
    _id: 'm_1',
    sessionId: 'session_1',
    status: 'done',
    role: 'assistant',
    sender: { type: 'agent', id: 'agent_1' },
    selectedVersion: 1,
    versionCount: 1,
  }
  const segments: Row[] = [
    {
      _id: 'c_0',
      messageId: 'm_1',
      version: 1,
      segmentIndex: 0,
      parts: [text('a0'), text('a1')],
    },
    {
      _id: 'c_1',
      messageId: 'm_1',
      version: 1,
      segmentIndex: 1,
      parts: [text('b0'), text('b1')],
    },
  ]
  return { message, segments }
}

describe('deleteMessageParts', () => {
  test('removes addressed parts within their segments', async () => {
    const { ctx, rows } = mutationCtx(fixture())

    const deleted = await deleteMessageParts(ctx, {
      messageId: 'm_1' as never,
      addresses: [
        { segmentIndex: 0, partIndex: 1 },
        { segmentIndex: 1, partIndex: 0 },
      ],
    })

    expect(deleted).toBe(false)
    expect(rows.map((row) => row.parts)).toEqual([[text('a0')], [text('b1')]])
  })

  test('expands `from` across all later parts and segments', async () => {
    const { ctx, rows, deletes } = mutationCtx(fixture())

    const deleted = await deleteMessageParts(ctx, {
      messageId: 'm_1' as never,
      addresses: [],
      from: { segmentIndex: 0, partIndex: 1 },
    })

    expect(deleted).toBe(false)
    // Segment 1 emptied entirely and its row is dropped (no renumbering)
    expect(deletes).toContain('c_1')
    expect(rows.map((row) => row._id)).toEqual(['c_0'])
    expect(rows[0].parts).toEqual([text('a0')])
  })

  test('deletes the whole message when nothing remains', async () => {
    const { ctx, deletes } = mutationCtx(fixture())

    const deleted = await deleteMessageParts(ctx, {
      messageId: 'm_1' as never,
      addresses: [],
      from: { segmentIndex: 0, partIndex: 0 },
    })

    expect(deleted).toBe(true)
    expect(deletes).toContain('m_1')
  })
})

describe('deleteMessageAttachment', () => {
  const first = {
    type: 'file',
    url: 'attachment:a',
    attachmentId: 'a',
    filename: 'same.png',
  }
  const second = { ...first, url: 'attachment:b', attachmentId: 'b' }
  const caption = text('Keep this caption')
  const selection = {
    messageId: 'm_1' as never,
    address: { segmentIndex: 1, partIndex: 1 },
    expectedVersion: 1,
    expectedSegmentPartCount: 3,
    expectedFileKey: messageFileKey(second)!,
  }

  function withAttachments() {
    const { message, segments } = fixture()
    message.sender = { type: 'user', id: 'user_1' }
    segments[1].parts = [first, second, caption]
    return { message, segments }
  }

  test('removes only the selected occurrence and releases its unused storage', async () => {
    const { message, segments } = withAttachments()
    const { ctx, rows, deletedStorage } = lifecycleDatabase({
      messages: [message],
      messageContents: segments,
      sessions: [{ _id: 'session_1', ownerId: 'user_1' }],
      userSessions: [
        {
          _id: 'member_1',
          userId: 'user_1',
          sessionId: 'session_1',
          role: 'owner',
        },
      ],
      attachments: [
        { _id: 'a', messageId: message._id, fileId: 'file_a' },
        { _id: 'b', messageId: message._id, fileId: 'file_b' },
      ],
      attachmentFiles: [
        { _id: 'file_a', storageId: 'blob_a' },
        { _id: 'file_b', storageId: 'blob_b' },
      ],
    })
    const ownerCtx = Object.assign(ctx, { userId: 'user_1', role: 'user' })

    expect(await deleteMessageAttachment(ownerCtx, selection)).toBe(false)
    expect(rows('messageContents')[0].parts).toEqual([text('a0'), text('a1')])
    expect(rows('messageContents')[1].parts).toEqual([first, caption])
    expect(rows('attachments').map((row) => row._id)).toEqual(['a'])
    expect(deletedStorage).toEqual(['blob_b'])
  })

  test('deletes the message when only the selected file and empty markers remain', async () => {
    const { message, segments } = withAttachments()
    segments[0].parts = [{ type: 'step-start' }]
    segments[1].parts = [text(' '), second]
    const { ctx, deletes } = mutationCtx({ message, segments })

    expect(
      await deleteMessageAttachment(ctx, {
        ...selection,
        expectedSegmentPartCount: 2,
      }),
    ).toBe(true)
    expect(deletes).toContain(message._id)
  })

  test.each([
    { expectedVersion: 2 },
    { expectedSegmentPartCount: 4 },
    { expectedFileKey: messageFileKey(first)! },
  ])(
    'rejects a stale selection without changing the message (%o)',
    async (overrides) => {
      const { ctx, rows, deletes, patches } = mutationCtx(withAttachments())

      await expect(
        deleteMessageAttachment(ctx, { ...selection, ...overrides }),
      ).rejects.toThrow('Reopen the menu')
      expect(rows[1].parts).toEqual([first, second, caption])
      expect(deletes).toHaveLength(0)
      expect(patches).toHaveLength(0)
    },
  )

  test('rejects an eligible session member deleting another user’s attachment', async () => {
    const { ctx, rows } = mutationCtx(withAttachments(), 'another_user')

    await expect(deleteMessageAttachment(ctx, selection)).rejects.toThrow(
      'Forbidden',
    )
    expect(rows[1].parts).toEqual([first, second, caption])
  })
})

describe('editMessagePart', () => {
  test('edits a part in a later segment without touching others', async () => {
    const { ctx, rows } = mutationCtx(fixture())

    await editMessagePart(ctx, {
      messageId: 'm_1' as never,
      segmentIndex: 1,
      partIndex: 1,
      text: 'edited',
    })

    expect(rows[0].parts).toEqual([text('a0'), text('a1')])
    expect(rows[1].parts).toEqual([text('b0'), text('edited')])
  })

  test('rejects an address pointing at a missing segment', async () => {
    const { ctx } = mutationCtx(fixture())

    expect(
      editMessagePart(ctx, {
        messageId: 'm_1' as never,
        segmentIndex: 5,
        partIndex: 0,
        text: 'nope',
      }),
    ).rejects.toThrow()
  })
})
