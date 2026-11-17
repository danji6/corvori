/// <reference types="bun-types" />
import { redeem } from '@cv/convex/model/session/shares'
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
