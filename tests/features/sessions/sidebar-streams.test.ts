import type { Id } from '@cv/convex/_generated/dataModel'
import { activeSessionIdsForSessions } from '@cv/convex/model/stream/reads'
import { SIDEBAR_STREAM_BATCH_SIZE } from '@cv/core/sidebar-streams'
import { expect, test } from 'bun:test'
import { skillsDatabase } from '~/tests/helpers/skills-db'

test('sidebar status deduplicates visible sessions and follows membership and the final stream', async () => {
  const { ctx, db } = skillsDatabase()
  const visible = (await db.insert('sessions', {})) as Id<'sessions'>
  const foreign = (await db.insert('sessions', {})) as Id<'sessions'>
  const idle = (await db.insert('sessions', {})) as Id<'sessions'>
  const member = await db.insert('userSessions', {
    sessionId: visible,
    userId: ctx.userId,
    hidden: true,
  })
  await db.insert('userSessions', { sessionId: idle, userId: ctx.userId })
  await db.insert('userSessions', { sessionId: foreign, userId: 'other' })
  const first = await db.insert('streams', { sessionId: visible })
  const parked = await db.insert('streams', {
    sessionId: visible,
    state: { phase: 'awaiting_input' },
  })
  await db.insert('streams', { sessionId: foreign })

  const sessionIds = [foreign, visible, visible, idle]
  expect(await activeSessionIdsForSessions(ctx, { sessionIds })).toEqual([
    visible,
  ])
  await db.delete(first)
  expect(await activeSessionIdsForSessions(ctx, { sessionIds })).toEqual([
    visible,
  ])
  await db.delete(member)
  expect(await activeSessionIdsForSessions(ctx, { sessionIds })).toEqual([])
  await db.insert('userSessions', { sessionId: visible, userId: ctx.userId })
  await db.delete(parked)
  expect(await activeSessionIdsForSessions(ctx, { sessionIds })).toEqual([])
})

test('sidebar status accepts an empty batch and rejects oversized batches before reading', async () => {
  const { ctx } = skillsDatabase()
  const session = 'session' as Id<'sessions'>
  const fullBatch = Array<Id<'sessions'>>(SIDEBAR_STREAM_BATCH_SIZE).fill(
    session,
  )
  expect(await activeSessionIdsForSessions(ctx, { sessionIds: [] })).toEqual([])
  expect(
    await activeSessionIdsForSessions(ctx, { sessionIds: fullBatch }),
  ).toEqual([])
  await expect(
    activeSessionIdsForSessions(ctx, { sessionIds: [...fullBatch, session] }),
  ).rejects.toThrow('Too many sessions')
})
