/// <reference types="bun-types" />
import type { Id } from '@cv/convex/_generated/dataModel'
import { quoteMessage } from '@cv/convex/model/chat/replies'
import { insertMessage } from '@cv/convex/model/messageContents'
import { exportOne, importOne } from '@cv/convex/model/session/archive'
import type { SessionArchive } from '@cv/convex/model/session/archive'
import { describe, expect, test } from 'bun:test'
import { skillsDatabase } from '~/tests/helpers/skills-db'

function makeCtx() {
  const { ctx, rows } = skillsDatabase()
  rows('users').push({ _id: 'users_1', subject: 'sub_1' })
  return { ctx, rows }
}

type LegacyArchive = Extract<SessionArchive, { version: 1 }>

function message(): LegacyArchive['session']['messages'][number] {
  return {
    role: 'assistant',
    parts: [{ type: 'text', text: 'hi' }],
    senderSnapshot: { name: 'Ada', avatarKey: 'ada' },
  }
}

function archive(
  messages: LegacyArchive['session']['messages'],
): LegacyArchive {
  return {
    version: 1,
    exportedAt: 0,
    session: { title: 'Imported', messages },
  }
}

describe('session archive import', () => {
  test('preserves sender identity and content', async () => {
    const { ctx, rows } = makeCtx()
    await importOne(ctx, {
      subject: 'sub_1',
      avatars: { ada: 'storage_1' as never },
      payload: archive([message()]),
    })
    expect(rows('messages')).toHaveLength(1)
    const [author] = rows('sessionAuthors')
    expect(rows('messages')[0].sender).toEqual({
      type: 'archived',
      id: author._id,
    })
    expect(author.name).toBe('Ada')
    expect(rows('messages')[0].senderName).toBe('Ada')
    expect(author.avatarId).toBe(rows('avatars')[0]._id)
    expect(rows('avatars')[0].storageId).toBe('storage_1')
    expect(rows('messageContents')[0].parts).toEqual([
      { type: 'text', text: 'hi' },
    ])
  })

  test('imports messages without sender snapshots or avatar data', async () => {
    const { ctx, rows } = makeCtx()
    await importOne(ctx, {
      subject: 'sub_1',
      avatars: {},
      payload: archive([
        message(),
        {
          role: 'user',
          parts: [
            {
              type: 'text',
              text: '```sh\nhello\n```\n\n**Hello** from `Rome`',
            },
          ],
        },
      ]),
    })
    expect(rows('messages')).toHaveLength(2)
    expect(rows('avatars')).toEqual([])
    expect(rows('sessionAuthors')[0]).toMatchObject({
      name: 'Ada',
      kind: 'agent',
    })
    expect(rows('sessionAuthors')[0].avatarId).toBeUndefined()
    expect(rows('sessionAuthors')[1]).toMatchObject({ kind: 'user' })
    expect(rows('sessionAuthors')[1].name).toBeUndefined()
    expect(rows('sessions')[0].lastMessagePreview).toBe('Hello from Rome')
    expect(rows('messages')[1].role).toBe('user')
  })

  test('round-trips a context reset in transcript order', async () => {
    const { ctx, rows } = skillsDatabase()
    const sessionId = 'session' as Id<'sessions'>
    const ownerId = 'owner' as Id<'users'>
    const sender = { type: 'user' as const, id: ownerId }
    const fields = { sessionId, sender, status: 'done' as const }
    rows('users').push({ _id: ownerId, subject: 'owner' })
    rows('sessions').push({ _id: sessionId, ownerId })
    rows('userSessions').push({
      _id: 'member',
      sessionId,
      userId: ownerId,
      role: 'owner',
    })

    await insertMessage(ctx, { ...fields, role: 'user' }, [
      { type: 'text', text: 'Before' },
    ])
    await insertMessage(
      ctx,
      { ...fields, role: 'system', type: 'contextReset', hidden: true },
      [],
    )
    await insertMessage(ctx, { ...fields, role: 'user' }, [
      { type: 'text', text: 'After' },
    ])
    const exported = await exportOne(ctx, { sessionId, subject: 'owner' })
    const imported = await importOne(ctx, {
      payload: exported.archive,
      subject: 'owner',
      avatars: {},
    })

    const messages = rows('messages').filter(
      (row) => row.sessionId === imported.sessionId,
    )
    expect(messages.map((row) => row.role)).toEqual(['user', 'system', 'user'])
    expect(messages[1]).toMatchObject({
      type: 'contextReset',
      hidden: true,
      contextEligible: false,
    })
  })
})

test('round-trips distinct authors with identical display names into another install', async () => {
  const { ctx, rows } = makeCtx()
  const sessionId = 'origin-session' as Id<'sessions'>
  const first = 'first-person' as Id<'users'>
  const second = 'second-person' as Id<'users'>
  rows('sessions').push({ _id: sessionId, ownerId: 'users_1', title: 'Origin' })
  rows('userSessions').push({ _id: 'membership', sessionId, userId: 'users_1' })
  rows('settings').push(
    { _id: 'first-settings', ownerId: first, displayName: 'Same name' },
    {
      _id: 'second-settings',
      ownerId: second,
      displayName: 'Different global name',
    },
  )
  rows('sessionProfiles').push({
    _id: 'second-override',
    sessionId,
    sender: { type: 'user', id: second },
    name: 'Same name',
    avatarId: 'override-avatar',
  })
  rows('avatars').push({ _id: 'override-avatar', storageId: 'original-image' })

  const send = (
    id: Id<'users'>,
    text: string,
    replyTo?: Awaited<ReturnType<typeof quoteMessage>>,
  ) =>
    insertMessage(
      ctx,
      {
        sessionId,
        sender: { type: 'user', id },
        role: 'user',
        status: 'done',
        replyTo,
      },
      [{ type: 'text', text }],
    )
  const firstMessage = await send(first, 'One')
  await send(second, 'Two')
  await ctx.db.patch('first-settings' as Id<'settings'>, {
    displayName: 'New name',
  })
  const quote = await quoteMessage(ctx, sessionId, firstMessage.messageId)
  await send(first, 'Three', quote)
  await ctx.db.patch('first-settings' as Id<'settings'>, {
    displayName: 'Same name',
  })

  const { archive: payload, avatars } = await exportOne(ctx, {
    sessionId,
    subject: 'sub_1',
  })
  const [a, b] = payload.session.authors
  expect([a.name, b.name]).toEqual(['Same name', 'Same name'])
  expect(a.key).not.toBe(b.key)
  expect(b.avatarKey).toBe(avatars[0].key)
  expect(JSON.stringify(payload)).not.toContain('second-person')

  const destination = makeCtx()
  await importOne(destination.ctx, {
    payload,
    subject: 'sub_1',
    avatars: { [avatars[0].key]: 'imported-image' as Id<'_storage'> },
  })
  const messages = destination.rows('messages')
  expect(messages[0].sender).toEqual(messages[2].sender)
  expect(messages[0].sender).not.toEqual(messages[1].sender)
  expect(messages.map((message) => message.senderName)).toEqual([
    'Same name',
    'Same name',
    'New name',
  ])
  expect(messages[2].replyTo).toMatchObject({
    sender: messages[0].sender,
    senderName: 'Same name',
    text: 'One',
    target: { id: messages[0]._id },
  })
  const authors = destination.rows('sessionAuthors')
  expect(authors.map((author) => author.name)).toEqual([
    'Same name',
    'Same name',
  ])
  expect(authors[1].avatarId).toBe(destination.rows('avatars')[0]._id)
  expect(destination.rows('users')).toHaveLength(1)
  expect(destination.rows('userSessions')).toHaveLength(1)
  expect(destination.rows('agents')).toHaveLength(0)
})
