import type { Id } from '@cv/convex/_generated/dataModel'
import type { ActionCtx } from '@cv/convex/_generated/server'
import { buildProviderHistory } from '@cv/convex/actions/stream/history'
import {
  type ProviderHistorySnapshot,
  readHistorySnapshot,
} from '@cv/convex/actions/stream/historySnapshot'
import { deleteMessage } from '@cv/convex/model/chat/mutations'
import {
  addVersion,
  insertMessage,
  patchSegmentParts,
  setSegmentParts,
  setSelectedVersion,
} from '@cv/convex/model/messageContents'
import { prepareContextNote } from '@cv/convex/model/stream/contextNotes'
import {
  _getProviderHistory,
  _getProviderHistorySnapshot,
} from '@cv/convex/model/stream/providerHistory'
import type { StreamContext, StreamExecutionArgs } from '@cv/convex/types'
import { expect, test } from 'bun:test'
import { getFunctionName } from 'convex/server'
import { providerData } from '~/tests/helpers/provider-history'
import { skillsDatabase } from '~/tests/helpers/skills-db'

function fixture(sessionId = 'session') {
  const f = skillsDatabase({ by_messageId_version_segment: ['segmentIndex'] })
  f.rows('sessions').push({ _id: sessionId, ownerId: 'owner' })
  f.rows('users').push({ _id: 'owner' })
  f.rows('agents').push({ _id: 'agent', name: 'Agent' })
  let clock = 20
  const insert = f.db.insert
  f.db.insert = (table, fields) =>
    insert(table, { _creationTime: ++clock, ...fields })
  f.rows('userSessions').push({
    _id: 'member',
    userId: 'owner',
    sessionId,
    role: 'owner',
  })
  const execution = { streamId: 'stream', generation: 1 } as StreamExecutionArgs
  const data = providerData('prompt') as StreamContext
  const stream = {
    ...data.stream,
    sessionId,
    agentId: 'agent',
    invokedBy: 'owner',
    command: { kind: 'invoke' },
    leaseExpiresAt: Date.now() + 60000,
    _id: execution.streamId,
    generation: execution.generation,
    contextBoundaryCreationTime: 10,
    state: { phase: 'streaming', processingMessageId: 'output' },
  } as StreamContext['stream']
  data.stream = stream
  f.rows('streams').push(stream)
  const fields = {
    sessionId,
    selectedVersion: 1,
    versionCount: 1,
    contextEligible: true,
  }
  f.rows('messages').push(
    {
      ...fields,
      _id: 'prompt',
      _creationTime: 10,
      sender: { type: 'user', id: 'owner' },
      status: 'done',
      role: 'user',
    },
    {
      ...fields,
      _id: 'output',
      _creationTime: 11,
      sender: { type: 'agent', id: 'agent' },
      status: 'processing',
      role: 'assistant',
    },
  )
  for (const messageId of ['prompt', 'output']) {
    f.rows('messageContents').push({
      _id: messageId + '-part',
      sessionId,
      messageId,
      version: 1,
      segmentIndex: 0,
      parts: [text(messageId)],
    })
  }

  const reads: boolean[] = []
  const action = {
    runQuery: async (ref: never, args: StreamExecutionArgs) => {
      const name = getFunctionName(ref)
      if (name === 'attachments:_get') {
        return {
          storageId: 'preview',
          mediaType: 'image/png',
          filename: 'pixel.png',
        }
      }
      if (name === 'streams:_getProviderHistory') {
        return _getProviderHistory(f.ctx, args)
      }
      const result = await _getProviderHistorySnapshot(f.ctx, args)
      reads.push(result?.completed != null)
      return result
    },
    storage: { get: async () => new Blob([new Uint8Array([1, 2, 3])]) },
  } as unknown as ActionCtx
  const snapshot: ProviderHistorySnapshot = {}

  async function verify() {
    const rows = await readHistorySnapshot(action, execution, snapshot)
    expect(rows).toEqual(await _getProviderHistory(f.ctx, execution))
    expect(
      await buildProviderHistory(action, data, [], { historyRows: rows! }),
    ).toEqual(await buildProviderHistory(action, data, []))
    return rows!
  }

  return { ...f, action, data, execution, reads, snapshot, verify }
}

function text(value: string) {
  return { type: 'text', text: value }
}

test('reuses completed rows while joining fresh output from split segments', async () => {
  const f = fixture()
  await f.verify()
  const row = (await f.ctx.db.get('output-part' as Id<'messageContents'>))!
  const toolResult = {
    type: 'tool-write_todo',
    state: 'output-available',
    toolCallId: 'todo_1',
    input: { todos: [] },
    output: 'Saved todos',
  }
  await patchSegmentParts(f.ctx, row.messageId, row, [toolResult])
  const second = [text('later output')]
  await f.db.insert('messageContents', {
    ...row,
    _id: 'output-part-2',
    segmentIndex: 1,
    parts: second,
  })
  expect((await f.verify()).at(-1)?.parts).toEqual([toolResult, ...second])
  expect(f.reads).toEqual([true, false])
})

test('refreshes after a completed message edit, version switch and deletion', async () => {
  const f = fixture()
  await f.verify()
  const message = (await f.ctx.db.get('prompt' as Id<'messages'>))!
  const row = (await f.ctx.db.get('prompt-part' as Id<'messageContents'>))!
  await setSegmentParts(f.ctx, message, row, [text('edited')])
  expect((await f.verify())[0].parts).toEqual([text('edited')])

  await addVersion(f.ctx, { message, parts: [text('another version')] })
  expect((await f.verify())[0].parts).toEqual([text('another version')])
  const withVersion = (await f.ctx.db.get(message._id))!
  await setSelectedVersion(f.ctx, withVersion, 1)
  expect((await f.verify())[0].parts).toEqual([text('edited')])

  await setSegmentParts(f.ctx, { ...message }, row, [])
  expect((await f.verify())[0]?._id).not.toBe(message._id)
  await setSegmentParts(f.ctx, { ...message }, row, [text('restored')])
  expect((await f.verify())[0].parts).toEqual([text('restored')])

  await deleteMessage(f.ctx, { messageId: message._id })
  expect((await f.verify()).map(({ _id }) => String(_id))).toEqual(['output'])
  expect(f.reads.every((reloaded) => reloaded)).toBe(true)
})

test('keeps anchored notes fresh and replaces the snapshot across boundaries', async () => {
  const f = fixture()
  await f.verify()
  await prepareContextNote(
    f.ctx,
    {
      ...f.execution,
      contextId: 'catalog',
      fingerprint: 'new-context',
      content: 'New workspace context',
    },
    'workspace',
  )
  expect((await f.verify()).some(({ type }) => type === 'workspace')).toBe(true)

  const prompt = (await f.ctx.db.get('prompt' as Id<'messages'>))!
  const sender = prompt.sender
  const { messageId: reset } = await insertMessage(
    f.ctx,
    {
      sessionId: prompt.sessionId,
      sender,
      role: 'system',
      status: 'done',
      type: 'contextReset',
    },
    [],
  )
  await f.db.patch(reset, { _creationTime: 10 })
  expect((await f.verify()).some(({ _id }) => _id === prompt._id)).toBe(false)

  const { messageId: summary } = await insertMessage(
    f.ctx,
    {
      sessionId: prompt.sessionId,
      sender,
      role: 'assistant',
      status: 'done',
      type: 'summary',
      summaryBoundaryCreationTime: 10,
    },
    [text('summary')],
  )
  await f.db.patch(summary, { _creationTime: 12 })
  expect((await f.verify())[0]?._id).toBe(summary)

  await f.db.patch(f.execution.streamId, { generation: 2 })
  expect(
    await readHistorySnapshot(f.action, f.execution, f.snapshot),
  ).toBeNull()
  expect(f.snapshot.completed).toBeUndefined()
})

test('reapplies media omission to reused history rows', async () => {
  const f = fixture()
  await f.db.patch('prompt-part', {
    parts: [
      {
        type: 'file',
        url: 'attachment:pixel',
        attachmentId: 'pixel',
        mediaType: 'image/png',
        filename: 'pixel.png',
      },
    ],
  })
  const rows = await f.verify()
  const active = await buildProviderHistory(f.action, f.data, [], {
    historyRows: rows,
  })
  expect(JSON.stringify(active)).toContain('data:image/png')

  await f.db.patch(f.execution.streamId, { omitActiveMedia: true })
  const reused = await f.verify()
  const omitted = await buildProviderHistory(f.action, f.data, [], {
    historyRows: reused,
  })
  expect(JSON.stringify(omitted)).toContain('attachment-error')
  expect(JSON.stringify(omitted)).not.toContain('data:image/png')
  expect(f.reads).toEqual([true, false])
})

test('drops an oversized snapshot and rereads it on the next step', async () => {
  const f = fixture()
  const head = (await f.ctx.db.get('prompt-part' as Id<'messageContents'>))!
  const parts = [text('é'.repeat(30_000))]
  for (let segmentIndex = 1; segmentIndex <= 36; segmentIndex++) {
    const { _id: _headId, ...fields } = head
    await f.db.insert('messageContents', { ...fields, parts, segmentIndex })
  }
  await f.verify()
  expect(f.snapshot.completed).toBeUndefined()
  await f.verify()
  expect(f.reads).toEqual([true, true])
})

test('keeps snapshots isolated across independent sessions', async () => {
  const left = fixture()
  const right = fixture('another-session')
  await right.db.patch('prompt-part', { parts: [text('another session')] })
  await Promise.all([left.verify(), right.verify()])
  const [l, r] = await Promise.all([left.verify(), right.verify()])
  expect(l[0].parts).toEqual([text('prompt')])
  expect(r[0].parts).toEqual([text('another session')])
  expect(left.reads).toEqual([true, false])
  expect(right.reads).toEqual([true, false])
})
