import type { Id } from '@cv/convex/_generated/dataModel'
import {
  type TransferResult,
  advanceCopyPath,
  begin,
  finishCopy,
  finishPublish,
  mergePublishedAttachments,
  requireActive,
} from '@cv/convex/model/attachmentTransfers'
import {
  cleanUpGeneratedAttachments,
  getToolFile,
  getUrlMap,
} from '@cv/convex/model/attachments'
import { createAttachmentTransferTool } from '@cv/convex/model/tool/attachmentTransfers'
import { expect, spyOn, test } from 'bun:test'
import { type FunctionReference, getFunctionName } from 'convex/server'
import { skillsDatabase } from '~/tests/helpers/skills-db'

const execution = { streamId: 'stream' as never, generation: 1 }
const call = {
  ...execution,
  callId: 'publish',
  kind: 'attach_file' as const,
  request: '["session://report.txt",null]',
  path: 'session://report.txt',
}
const upload = {
  storageId: 'blob' as never,
  filename: 'report.txt',
  mediaType: 'text/plain',
}

function fixture() {
  const { ctx, db, rows } = skillsDatabase()
  Object.assign(db, {
    system: { get: async () => ({ size: 6 }) },
  })
  rows('streams').push({
    _id: 'stream',
    generation: 1,
    sessionId: 'child',
    invokedBy: 'owner',
    agentId: 'agent',
    state: {
      phase: 'streaming',
      processingMessageId: 'message',
      processingContentId: 'content',
    },
  })
  rows('sessions').push(
    { _id: 'root', ownerId: 'owner' },
    { _id: 'child', ownerId: 'owner', parent: { sessionId: 'root' } },
  )
  rows('userSessions').push({
    _id: 'membership',
    sessionId: 'root',
    userId: 'owner',
  })
  rows('agents').push({ _id: 'agent', tools: ['process_attachments'] })
  rows('messages').push({
    _id: 'message',
    sessionId: 'child',
    selectedVersion: 1,
  })
  rows('messageContents').push({
    _id: 'content',
    messageId: 'message',
    version: 1,
    segmentIndex: 0,
    parts: [],
  })
  return { ctx, db, rows }
}

test('publishes once in the child response while sharing the root working directory', async () => {
  const f = fixture()
  const operation = await begin(f.ctx, call)
  expect(String(operation.rootId)).toBe('root')
  expect((await begin(f.ctx, call))._id).toBe(operation._id)
  const result = await finishPublish(f.ctx, operation._id, execution, upload)
  expect(await finishPublish(f.ctx, operation._id, execution, upload)).toEqual(
    result,
  )
  expect((await begin(f.ctx, call)).result).toEqual(result)
  expect(f.rows('attachments')).toHaveLength(1)

  const content = f.rows('messageContents')[0]!
  const stale = [{ type: 'text', text: 'Done.' }]
  const parts = mergePublishedAttachments(content.parts as unknown[], stale)
  expect(parts).toEqual([
    ...stale,
    expect.objectContaining({
      type: 'file',
      attachmentId: result.attachmentId,
      filename: 'report.txt',
    }),
  ])
  await f.db.patch('content', { parts })
  await cleanUpGeneratedAttachments(f.ctx, execution.streamId)
  expect(f.rows('attachments')[0]?.streamId).toBeUndefined()
  expect(f.rows('attachments')[0]?.sessionId).toBe('child')
})

test('rechecks membership, plan mode, selection, and execution before publication', async () => {
  const f = fixture()
  const operation = await begin(f.ctx, call)
  await f.db.patch('agent', { tools: ['read_attachment'] })
  await expect(
    finishPublish(f.ctx, operation._id, execution, upload),
  ).rejects.toThrow('no longer enabled')

  await f.db.patch('agent', { tools: ['process_attachments'] })
  await f.db.patch('root', { mode: 'plan' })
  await expect(
    finishPublish(f.ctx, operation._id, execution, upload),
  ).rejects.toThrow('plan mode')

  await f.db.patch('root', { mode: undefined })
  await f.db.patch('stream', { generation: 2 })
  await expect(
    finishPublish(f.ctx, operation._id, execution, upload),
  ).rejects.toThrow('no longer active')

  await f.db.patch('stream', { generation: 1, invokedBy: 'outside' })
  await expect(
    finishPublish(f.ctx, operation._id, execution, upload),
  ).rejects.toThrow('Not found')
  expect(f.rows('attachments')).toHaveLength(0)
})

test('returns original image dimensions with the published attachment URL', async () => {
  const f = fixture()
  const operation = await begin(f.ctx, call)
  const imageDimensions = { width: 800, height: 1200 }
  const { attachmentId } = await finishPublish(
    f.ctx,
    operation._id,
    execution,
    {
      ...upload,
      filename: 'report.png',
      mediaType: 'image/png',
      imageDimensions,
    },
  )
  if (!attachmentId) throw new Error('Expected a published image attachment')
  const ctx = {
    ...f.ctx,
    userId: 'reader' as never,
    storage: {
      ...f.ctx.storage,
      getUrl: async () => 'https://storage.example.test/report.png',
    },
  }
  expect(await getUrlMap(ctx, { ids: [attachmentId] })).toEqual({})

  f.rows('userSessions').push({
    _id: 'child-membership',
    sessionId: 'child',
    userId: 'reader',
  })
  const urls = await getUrlMap(ctx, { ids: [attachmentId] })
  expect(urls[attachmentId]?.imageDimensions).toEqual(imageDimensions)
})

test('automatic copies advance on collision and retry an uncertain write at the same path', async () => {
  const { ctx, rows } = fixture()
  rows('attachments').push({ _id: 'local', sessionId: 'child', fileId: 'file' })
  rows('attachmentFiles').push({
    _id: 'file',
    storageId: 'blob',
    filename: 'report.txt',
    mediaType: 'text/plain',
    byteLength: 6,
  })
  rows('userSessions').push({
    _id: 'child-member',
    sessionId: 'child',
    userId: 'owner',
  })
  const writes: string[] = []
  const fetcher = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        if (!String(url).endsWith('/commit-copy')) return Response.json({})
        const { path } = JSON.parse(String(init?.body))
        writes.push(path)
        if (writes.length === 1) return Response.json({ status: 'occupied' })
        if (writes.length === 2)
          throw new TypeError('Connection lost after commit')
        return Response.json({ status: 'committed' })
      },
      { preconnect: fetch.preconnect },
    ),
  )
  const toolCtx = {
    storage: { getUrl: async () => 'https://storage.example.test/file' },
    runQuery: async (
      ref: FunctionReference<'query', 'internal'>,
      args: never,
    ) => {
      if (getFunctionName(ref) === 'attachments:_getToolFile')
        return getToolFile(ctx, args)
      const { id, ...execution } = args as {
        id: Id<'attachmentTransfers'>
      } & typeof call
      return (await requireActive(ctx, id, execution)).row.result ?? null
    },
    runMutation: async (
      ref: FunctionReference<'mutation', 'internal'>,
      args: never,
    ) => {
      switch (getFunctionName(ref)) {
        case 'attachments:_beginTransfer':
          return begin(ctx, args)
        case 'attachments:_advanceCopyPath':
          return advanceCopyPath(ctx, args)
        case 'attachments:_finishCopy': {
          const { id, result, ...execution } = args as {
            id: Id<'attachmentTransfers'>
            result: TransferResult
          } & typeof call
          return finishCopy(ctx, id, execution, result)
        }
      }
    },
  }
  try {
    const tool = await createAttachmentTransferTool(
      'copy_attachment',
      toolCtx as never,
      execution,
    )
    const input = { reference: 'attachment:local/report.txt' } as never
    const options = {
      toolCallId: 'copy',
      messages: [],
      context: undefined as never,
    }
    const result = await tool.execute!(input, options)
    expect(result).toMatchObject({ path: 'session://attachments/report-2.txt' })
    expect(rows('attachmentTransfers')[0].path).toBe(
      'session://attachments/report-2.txt',
    )
    expect(await tool.execute!(input, options)).toEqual(result)
    expect(writes).toEqual([
      'session://attachments/report.txt',
      'session://attachments/report-2.txt',
      'session://attachments/report-2.txt',
    ])
  } finally {
    fetcher.mockRestore()
  }
})
