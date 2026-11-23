/// <reference types="bun-types" />
import { preview, redeem } from '@cv/convex/model/session/shares'
import { list } from '@cv/convex/model/userSessions'
import { expect, test } from 'bun:test'

import { lifecycleDatabase } from '../../helpers/lifecycle-db'

async function sha256(text: string) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text),
  )
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}

test('announces a share redemption once, as a hidden system note', async () => {
  const database = lifecycleDatabase({
    sessions: [{ _id: 'session', ownerId: 'owner' }],
    sessionShares: [
      { _id: 'share', sessionId: 'session', tokenHash: await sha256('t') },
    ],
    settings: [{ _id: 'settings', ownerId: 'member', displayName: 'Alice' }],
  })
  const ctx = { ...(database.ctx as object), userId: 'member' } as never

  await redeem(ctx, { token: 't' })
  await redeem(ctx, { token: 't' })

  const [notice, ...rest] = database.rows('messages')
  expect(rest).toHaveLength(0)
  expect(notice).toMatchObject({
    sessionId: 'session',
    sender: { type: 'user', id: 'member' },
    role: 'system',
    type: 'presence',
    hidden: true,
    contextEligible: true,
    extra: {
      event: 'joined',
      participant: { type: 'user', id: 'member' },
      name: 'Alice',
    },
  })

  const [content] = database.rows('messageContents')
  const [part] = content!.parts as { text: string }[]
  expect(part!.text).toContain('Alice has joined the session')
})

test('publishes the join profile with the membership and preserves it on retries and rejoin', async () => {
  const database = lifecycleDatabase({
    sessions: [{ _id: 'session', ownerId: 'owner' }],
    userSessions: [
      {
        _id: 'owner-member',
        sessionId: 'session',
        userId: 'owner',
        role: 'owner',
      },
    ],
    sessionShares: [
      { _id: 'share', sessionId: 'session', tokenHash: await sha256('t') },
    ],
    settings: [
      {
        _id: 'settings',
        ownerId: 'member',
        displayName: 'Account name',
        avatarId: 'account-avatar',
      },
    ],
  })
  const ctx = { ...(database.ctx as object), userId: 'member' } as never
  const owner = { ...(database.ctx as object), userId: 'owner' } as never
  const sessionId = 'session' as never

  expect(await preview(ctx, { token: 'wrong' })).toBeNull()
  expect(
    await redeem(ctx, { token: 'wrong', profile: { name: 'Ignored' } }),
  ).toBeNull()
  expect(database.rows('sessionProfiles')).toHaveLength(0)

  expect(await preview(ctx, { token: 't' })).toMatchObject({
    isMember: false,
    profile: {
      inherited: { name: 'Account name', avatarId: 'account-avatar' },
    },
  })
  await redeem(ctx, { token: 't', profile: { name: 'Alex', avatar: 'clear' } })
  expect(
    await redeem(ctx, {
      token: 't',
      profile: { name: 'Ignored', avatar: 'inherit' },
    }),
  ).toBe(sessionId)
  expect(await preview(ctx, { token: 't' })).toEqual({
    isMember: true,
    sessionId,
  })
  const [member] = (await list(owner, { sessionId })).filter(
    ({ membership }) => membership.userId === 'member',
  )
  expect(member?.name).toBe('Alex')
  expect(member?.avatarId).toBeUndefined()
  expect(database.rows('messages')).toHaveLength(1)
  expect(database.rows('messages')[0]?.extra).toMatchObject({
    name: 'Alex',
    event: 'joined',
  })

  await (
    database.ctx as { db: { delete: (id: string) => Promise<void> } }
  ).db.delete(member!.membership._id)
  expect(await preview(ctx, { token: 't' })).toMatchObject({
    isMember: false,
    profile: { name: 'Alex', avatarId: null },
  })
  await redeem(ctx, { token: 't' })
  expect(database.rows('messages')[1]?.extra).toMatchObject({
    name: 'Alex',
    event: 'joined',
  })
})
