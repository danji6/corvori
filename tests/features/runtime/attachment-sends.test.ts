import type { Id } from '@cv/convex/_generated/dataModel'
import { confirm, getUrlMap } from '@cv/convex/model/attachments/files'
import {
  beginAttachmentSend,
  discardAttachmentSend,
  renewAttachmentSend,
  sweepAttachmentSends,
} from '@cv/convex/model/chat/attachmentSends'
import { invokeAgent, sendMessage } from '@cv/convex/model/chat/send'
import { _claim } from '@cv/convex/model/stream/lifecycleClaims'
import { _continue } from '@cv/convex/model/stream/lifecycleProgress'
import { _complete } from '@cv/convex/model/stream/lifecycleTerminal'
import { _getProviderHistory } from '@cv/convex/model/stream/reads'
import { expect, test } from 'bun:test'
import { skillsDatabase } from '~/tests/helpers/skills-db'

const sessionId = 'session' as Id<'sessions'>
const owner = 'owner' as Id<'users'>
const collaborator = 'collaborator' as Id<'users'>
const firstKey = 'f8f3dd4b-f817-4c9b-bb92-c6605f1d7458'
const secondKey = '610031e7-6f1a-44e4-bfc2-74422201d6b1'

function fixture() {
  const state = skillsDatabase({
    by_sessionId_expiresAt: ['sessionId', 'expiresAt'],
  })
  const { ctx, db, rows } = state
  const deleted: string[] = []
  const insert = db.insert
  let order = 1
  db.insert = (table, value) =>
    insert(table, { _creationTime: order++, ...value })
  Object.assign(db, { system: { get: async () => ({ size: 42 }) } })
  Object.assign(ctx, {
    storage: {
      delete: async (id: string) => {
        deleted.push(id)
      },
      getUrl: async () => 'https://storage.example.test/file',
    },
  })
  Object.assign(ctx.scheduler, { cancel: async () => {} })
  rows('sessions').push({
    _id: sessionId,
    ownerId: owner,
    activeAgentId: 'agent',
  })
  rows('agents').push({ _id: 'agent', ownerId: owner, name: 'Agent' })
  rows('sessionAgents').push({ _id: 'linked', sessionId, agentId: 'agent' })
  for (const userId of [owner, collaborator]) {
    rows('userSessions').push({
      _id: `member-${userId}`,
      sessionId,
      userId,
      role: 'owner',
    })
  }

  const teammate = { ...ctx, userId: collaborator }
  const begin = async (clientSendId = firstKey, user = ctx) =>
    (
      await beginAttachmentSend(user, {
        sessionId,
        clientSendId,
        occurrenceIds: ['file'],
      })
    ).pendingId!
  const stage = (id: Id<'attachmentSends'>, user = ctx) =>
    confirm(
      user,
      {
        sessionId,
        pendingSend: { id, occurrenceId: 'file' },
        filename: 'input.txt',
        mediaType: 'text/plain',
        storageId: `blob-${id}` as Id<'_storage'>,
      },
      user.userId,
    )
  const execution = async () => {
    const streamId = rows('streams')[0]!._id as Id<'streams'>
    const stream = (await ctx.db.get(streamId))!
    return { streamId, generation: stream.generation }
  }
  return { ...state, teammate, begin, stage, execution, deleted }
}

test('delivers later text while holding the already queued agent for every pending send', async () => {
  const f = fixture()
  const initial = await sendMessage(f.ctx, { sessionId, content: 'Start' })
  const queued = await f.execution()
  const first = await f.begin()
  const second = await f.begin(secondKey, f.teammate)

  expect(await _claim(f.ctx, queued)).toBeNull()
  expect(f.rows('streams')[0]).toMatchObject({
    state: { phase: 'awaiting_attachments' },
  })
  const later = await sendMessage(f.teammate, {
    sessionId,
    content: 'Later text',
  })
  expect(f.rows('messages').map(({ _id }) => _id)).toEqual([initial, later])

  await expect(
    sendMessage(f.ctx, {
      sessionId,
      clientSendId: firstKey,
      content: 'Incomplete',
      attachmentSendId: first,
    }),
  ).rejects.toThrow('Attachments are not ready')
  const staged = await f.stage(first)
  expect(await f.stage(first)).toBe(staged)
  expect(await getUrlMap(f.teammate, { ids: [staged] })).toEqual({})
  const args = {
    sessionId,
    content: '',
    clientSendId: firstKey,
    attachmentSendId: first,
    attachments: [{ id: staged }],
  }
  await expect(sendMessage(f.teammate, args)).rejects.toThrow(
    'Attachment send is unavailable',
  )
  const attachmentMessage = await sendMessage(f.ctx, args)
  expect(await sendMessage(f.ctx, args)).toBe(attachmentMessage)
  expect(await getUrlMap(f.teammate, { ids: [staged] })).toHaveProperty(staged)
  expect(f.rows('messages').map(({ _id }) => _id)).toEqual([
    initial,
    later,
    attachmentMessage,
  ])
  expect(f.rows('streams')[0]).toMatchObject({
    state: { phase: 'awaiting_attachments' },
  })
  await expect(discardAttachmentSend(f.ctx, { id: second })).rejects.toThrow(
    'Attachment send is unavailable',
  )
  await discardAttachmentSend(f.teammate, { id: second })

  const execution = await f.execution()
  const claimed = await _claim(f.ctx, execution)
  expect(claimed?.contextBoundaryMessageId).toBe(attachmentMessage)
  const history = await _getProviderHistory(f.ctx, execution)
  expect(history.map(({ _id }) => _id)).toEqual([
    initial,
    later,
    attachmentMessage,
  ])
})

test.each([false, true])(
  'an in-flight turn keeps its context if the upload settles before completion: %s',
  async (settleEarly) => {
    const f = fixture()
    const initial = await sendMessage(f.ctx, { sessionId, content: 'Start' })
    const execution = await f.execution()
    const active = (await _claim(f.ctx, execution))!
    const id = await f.begin()
    const later = await sendMessage(f.teammate, {
      sessionId,
      content: 'Later text',
    })
    await f.ctx.db.patch(active.state.processingContentId!, {
      parts: [{ type: 'text', text: 'Original answer' }],
    })

    if (settleEarly) await discardAttachmentSend(f.ctx, { id })
    await _continue(f.ctx, execution)
    expect(await f.ctx.db.get(execution.streamId)).toMatchObject({
      contextBoundaryMessageId: initial,
      state: { processingMessageId: active.state.processingMessageId },
    })
    await _complete(f.ctx, execution)
    if (!settleEarly) {
      expect(f.rows('streams')[0]).toMatchObject({
        state: { phase: 'awaiting_attachments' },
      })
      await discardAttachmentSend(f.ctx, { id })
    }
    const followUp = await _claim(f.ctx, await f.execution())
    expect(followUp?.contextBoundaryMessageId).toBe(later)
  },
)

test('an attachment send uses one slow-mode slot at registration', async () => {
  const f = fixture()
  await f.ctx.db.patch(sessionId, { settings: { slowModeMs: 60_000 } })
  const id = await f.begin()
  const attachmentId = await f.stage(id)
  await expect(
    sendMessage(f.ctx, { sessionId, content: 'Another message' }),
  ).rejects.toThrow('Slow mode')
  const later = await sendMessage(f.teammate, {
    sessionId,
    content: 'Another participant',
  })
  await sendMessage(f.ctx, {
    sessionId,
    content: '',
    clientSendId: firstKey,
    attachmentSendId: id,
    attachments: [{ id: attachmentId }],
  })
  expect(f.rows('messages').map(({ _id }) => _id)[0]).toBe(later)
  expect(f.rows('messages')).toHaveLength(2)
})

test('manual Continue waits while silent sends and expired reservations settle', async () => {
  const f = fixture()
  const silent = await f.begin()
  const silentFile = await f.stage(silent)
  await sendMessage(f.ctx, {
    sessionId,
    content: '',
    clientSendId: firstKey,
    attachmentSendId: silent,
    attachments: [{ id: silentFile }],
    silent: true,
  })
  expect(f.rows('streams')).toHaveLength(0)

  const pending = await f.begin(secondKey)
  await f.stage(pending)
  expect(await renewAttachmentSend(f.teammate, { id: pending })).toBe(false)
  expect(await renewAttachmentSend(f.ctx, { id: pending })).toBe(true)
  await invokeAgent(f.teammate, { sessionId })
  expect(f.rows('streams')[0]).toMatchObject({
    state: { phase: 'awaiting_attachments' },
  })

  await f.ctx.db.patch(pending, { expiresAt: Date.now() - 1 })
  expect(await renewAttachmentSend(f.ctx, { id: pending })).toBe(false)
  await sweepAttachmentSends(f.ctx)
  expect(f.rows('attachmentSends')).toHaveLength(0)
  expect(f.deleted).toEqual([`blob-${pending}`])
  expect(f.rows('streams')[0]).toMatchObject({ state: { phase: 'pending' } })
})
