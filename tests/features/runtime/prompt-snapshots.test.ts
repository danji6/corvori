import type { Id } from '@cv/convex/_generated/dataModel'
import { stopStream } from '@cv/convex/model/chat/controls'
import {
  insertMessage,
  setSegmentParts,
} from '@cv/convex/model/messageContents'
import {
  reserveMessageEvaluation,
  reserveStreamEvaluation,
} from '@cv/convex/model/promptEvaluation/reserve'
import {
  finishEvaluation,
  pendingHistory,
  pinInstance,
  readResult,
  readState,
  stageItem,
} from '@cv/convex/model/promptEvaluation/state'
import { removeForSession } from '@cv/convex/model/session/cache'
import { patchState } from '@cv/convex/model/session/state'
import type { Prompt, PromptItem } from '@cv/convex/types'
import { expect, test } from 'bun:test'
import { skillsDatabase } from '~/tests/helpers/skills-db'

const system: Prompt = {
  id: 'system',
  name: 'System',
  content: '{{ shell("git status") }}',
  role: 'system',
  enabled: true,
  visible: false,
}
const marker: PromptItem = { type: 'message-history' }

function fixture() {
  const f = skillsDatabase({ by_evaluationId_position: ['position'] })
  const sessionId = 'session' as Id<'sessions'>
  const agentId = 'agent' as Id<'agents'>
  const userId = 'invoker' as Id<'users'>
  const ownerId = 'owner' as Id<'users'>
  const execution = { streamId: 'stream' as Id<'streams'>, generation: 1 }
  const session = { _id: sessionId, ownerId: userId, activeAgentId: agentId }
  const agent = { _id: agentId, name: 'Agent', ownerId }
  f.rows('sessions').push(session)
  f.rows('agents').push(agent)
  f.rows('users').push(
    { _id: userId, role: 'admin' },
    { _id: ownerId, role: 'admin' },
  )
  f.rows('userSessions').push({
    _id: 'member',
    sessionId,
    userId,
    role: 'owner',
  })
  f.rows('streams').push({
    ...execution,
    _id: execution.streamId,
    _creationTime: 10,
    sessionId,
    agentId,
    invokedBy: userId,
    state: { phase: 'streaming' },
    command: { kind: 'retry' },
    contextBoundaryCreationTime: 100,
  })
  const snapshot = () =>
    reserveStreamEvaluation(f.ctx, {
      ...execution,
      kind: 'snapshot',
      items: [system, marker],
    })
  async function message(origin: 'reminder' | 'starter', time: number) {
    const parts = [{ type: 'text', text: system.content }]
    const target = await insertMessage(
      f.ctx,
      {
        sessionId,
        sender: { type: 'agent', id: agentId },
        status: 'done',
        role: 'assistant',
      },
      parts,
    )
    await f.db.patch(target.messageId, { _creationTime: time })
    await reserveMessageEvaluation(f.ctx, {
      ...target,
      agent,
      sessionId,
      invokedBy: userId,
      parts,
      origin,
      promptId: origin,
    })
    const row = (await f.ctx.db.get(target.contentId))!
    return { ...target, id: row.promptEvaluationId! }
  }
  return { ...f, sessionId, userId, ownerId, snapshot, execution, message }
}

test('freezes one reservation across handoff and retries until /eval invalidates it', async () => {
  const f = fixture()
  const id = (await f.snapshot())!
  expect(await f.snapshot()).toBe(id)
  expect(await pinInstance(f.ctx, { id, bootId: 'original' })).toEqual({
    bootId: 'original',
    start: true,
  })
  expect(await pinInstance(f.ctx, { id, bootId: 'successor' })).toEqual({
    bootId: 'original',
    start: false,
  })
  const itemId = f.rows('promptEvaluationItems')[0]!
    ._id as Id<'promptEvaluationItems'>
  await stageItem(f.ctx, { id, itemId, content: 'captured\n' })
  await patchState(f.ctx, f.sessionId, { environment: { unrelated: 1 } })
  expect(
    await finishEvaluation(f.ctx, { id, writes: { captured: true } }),
  ).toBe(true)
  expect(await readResult(f.ctx, { id })).toEqual([
    { ...system, content: 'captured\n' },
    marker,
  ])
  expect(f.rows('sessionState')[0]?.environment).toEqual({
    unrelated: 1,
    captured: true,
  })
  expect(await f.snapshot()).toBe(id)
  await removeForSession(f.ctx, f.sessionId)
  expect(await readResult(f.ctx, { id })).toBeNull()
  expect(await f.snapshot()).not.toBe(id)
})

test('checks the current invoker and owner roles for every dispatch grant', async () => {
  const f = fixture()
  const id = (await f.snapshot())!
  expect((await readState(f.ctx, { id }))?.allowed).toBe(true)
  await f.db.patch(f.ownerId, { role: 'moderator' })
  expect((await readState(f.ctx, { id }))?.allowed).toBe(false)
  await f.db.patch(f.ownerId, { role: 'admin' })
  await f.db.patch(f.userId, { role: 'user' })
  expect((await readState(f.ctx, { id }))?.allowed).toBe(false)
})

test('waits for the starter and due reminder in range and preserves edits', async () => {
  const f = fixture()
  const starter = await f.message('starter', 25)
  const first = await f.message('reminder', 50)
  const later = await f.message('reminder', 150)
  expect(first.id).not.toBe(later.id)
  expect(await pendingHistory(f.ctx, f.execution)).toMatchObject({
    waiting: true,
  })
  await finishEvaluation(f.ctx, {
    id: starter.id,
    parts: [{ type: 'text', text: 'Welcome' }],
  })
  expect(await pendingHistory(f.ctx, f.execution)).toMatchObject({
    waiting: true,
  })
  const message = (await f.ctx.db.get(first.messageId))!
  const row = (await f.ctx.db.get(first.contentId))!
  const parts = [{ type: 'text', text: 'Edited reminder' }]
  await setSegmentParts(f.ctx, message, row, parts)
  expect(await finishEvaluation(f.ctx, { id: first.id, parts: [] })).toBe(false)
  expect(await f.ctx.db.get(first.contentId)).toMatchObject({ parts })
  expect(await pendingHistory(f.ctx, f.execution)).toMatchObject({
    waiting: false,
  })
})

test('Stop cancels an authored message before any stream exists', async () => {
  const f = fixture()
  await f.db.delete(f.execution.streamId)
  const { id, contentId } = await f.message('starter', 25)
  await pinInstance(f.ctx, { id, bootId: 'sidecar-instance' })
  await stopStream({ ...f.ctx, userId: f.userId }, { sessionId: f.sessionId })
  expect(await finishEvaluation(f.ctx, { id, parts: [] })).toBe(false)
  expect(await f.ctx.db.get(contentId)).toMatchObject({
    parts: [{ type: 'text', text: 'Prompt evaluation stopped' }],
  })
  expect(f.scheduled.at(-1)?.args).toEqual({ id, bootId: 'sidecar-instance' })
})
