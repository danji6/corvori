import { resolveAttachmentHistoryParts } from '@cv/convex/model/stream/attachmentHistory'
import { canReplayToolContext } from '@cv/core/tool-context'
import * as checkpointModule from '@cv/sidecar/checkpoints/manager'
import { CheckpointManager } from '@cv/sidecar/checkpoints/manager'
import { createApp } from '@cv/sidecar/main'
import {
  readWorkspaceFile,
  writeWorkspaceFile,
} from '@cv/sidecar/mcp/workspace/workspace'
import { resolveShellDirectory } from '@cv/sidecar/shell/directory'
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test'
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  CheckpointBarrierStorage,
  checkpointDeadline,
} from '~/tests/helpers/checkpoint-barrier'

const original = new TextEncoder().encode('original attachment\n')
const previousData = process.env.CHAT_SIDECAR_DATA_DIR
let root: string
let app: ReturnType<typeof createApp>
let storage: ReturnType<typeof Bun.serve>
let uploaded: ArrayBuffer | undefined

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'session-attachments-'))
  process.env.CHAT_SIDECAR_DATA_DIR = path.join(root, 'data')
  app = createApp((_, next) => next())
  storage = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      if (request.method === 'GET') return new Response(original)
      uploaded = await request.arrayBuffer()
      return Response.json({ storageId: 'stored_snapshot' })
    },
  })
})

afterAll(async () => {
  storage?.stop(true)
  if (previousData === undefined) delete process.env.CHAT_SIDECAR_DATA_DIR
  else process.env.CHAT_SIDECAR_DATA_DIR = previousData
  if (root) await rm(root, { recursive: true, force: true })
})

function call(action: string, body: unknown) {
  return app.request(`/session-files/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function workspace(sessionId: string) {
  return {
    sessionId,
    workspaceId: sessionId,
    workspace: {
      workspaceId: sessionId,
      label: 'Session directory',
      path: '.',
      sessionFiles: true,
      sessionOnly: true,
    },
  }
}

test('copies once, edits in a chat without a project, and publishes an independent snapshot', async () => {
  const target = {
    sessionId: 'root',
    operationId: 'copy',
    path: 'session://in/notes.txt',
  }
  const copy = { ...target, url: storage.url.href, byteLength: original.length }
  expect((await call('stage-copy', copy)).ok).toBe(true)
  expect((await call('commit-copy', target)).ok).toBe(true)
  expect((await call('commit-copy', target)).ok).toBe(true)
  await call('cleanup-transfer', {
    operationId: target.operationId,
    discardUpload: false,
  })

  const directory = await resolveShellDirectory(workspace('root'))
  expect(directory.cwd).toBe(path.join(root, 'data', 'sessions', 'root'))
  expect(directory.environment.SESSION_DIR).toBe(directory.cwd)
  const file = await readWorkspaceFile({
    ...workspace('root'),
    filePath: 'in/notes.txt',
  })
  expect(file).toMatchObject({
    path: target.path,
    content: 'original attachment\n',
  })
  await writeWorkspaceFile({
    ...workspace('root'),
    filePath: 'session://out.txt',
    content: 'edited',
  })
  const output = {
    ...target,
    operationId: 'publish',
    path: 'session://out.txt',
    url: storage.url.href,
  }
  const published = await call('publish', output)
  expect(await published.json()).toEqual({
    filename: 'out.txt',
    storageId: 'stored_snapshot',
    mediaType: 'text/plain',
  })
  expect(new TextDecoder().decode(uploaded)).toBe('edited')
  await writeFile(path.join(directory.cwd, 'out.txt'), 'changed again')
  expect(new TextDecoder().decode(uploaded)).toBe('edited')
  expect(await readFile(path.join(directory.cwd, 'in', 'notes.txt'))).toEqual(
    Buffer.from(original),
  )
  expect(await (await fetch(storage.url)).text()).toBe('original attachment\n')
})

test('transfer routes reject escapes, hard links, incomplete copies, and existing targets', async () => {
  const sessionId = 'isolated'
  const session = await resolveShellDirectory(workspace(sessionId))
  const outside = path.join(root, 'outside')
  await mkdir(outside)
  await writeFile(path.join(outside, 'file.txt'), 'outside')
  await symlink(outside, path.join(session.cwd, 'other'))
  await link(
    path.join(outside, 'file.txt'),
    path.join(session.cwd, 'linked.txt'),
  )
  const transfer = {
    sessionId,
    url: storage.url.href,
    byteLength: original.length,
  }
  for (const [index, file] of [
    'workspace://file.txt',
    'session://../file.txt',
    'session://other/file.txt',
    'session://linked.txt',
  ].entries()) {
    expect(
      (
        await call('publish', {
          ...transfer,
          operationId: `bad-${index}`,
          path: file,
        })
      ).ok,
    ).toBe(false)
  }
  const target = {
    ...transfer,
    operationId: 'partial',
    path: 'session://partial.txt',
  }
  expect(
    (await call('stage-copy', { ...target, byteLength: original.length + 1 }))
      .ok,
  ).toBe(false)
  expect((await call('commit-copy', target)).ok).toBe(false)
  expect((await call('stage-copy', target)).ok).toBe(true)
  await writeFile(path.join(session.cwd, 'partial.txt'), 'existing')
  expect(await (await call('commit-copy', target)).json()).toEqual({
    status: 'occupied',
  })
  await call('cleanup-transfer', {
    operationId: target.operationId,
    rollback: target,
    discardUpload: false,
  })
  expect(await readFile(path.join(session.cwd, 'partial.txt'), 'utf8')).toBe(
    'existing',
  )
})

test('two staged copies cannot commit to the same filename', async () => {
  const target = { sessionId: 'race', path: 'session://attachments/notes.txt' }
  const copies = ['race1', 'race2'].map((operationId) => ({
    ...target,
    operationId,
    url: storage.url.href,
    byteLength: original.length,
  }))
  await Promise.all(
    copies.map(async (copy) => {
      expect((await call('stage-copy', copy)).ok).toBe(true)
    }),
  )
  const outcomes = await Promise.all(
    copies.map(
      async (copy) =>
        (await call('commit-copy', copy)).json() as Promise<{ status: string }>,
    ),
  )
  expect(outcomes.map(({ status }) => status).sort()).toEqual([
    'committed',
    'occupied',
  ])
  const loser =
    copies[outcomes.findIndex(({ status }) => status === 'occupied')]
  const next = { ...loser, path: 'session://attachments/notes-2.txt' }
  expect(await (await call('commit-copy', next)).json()).toEqual({
    status: 'committed',
  })
  expect(await (await call('commit-copy', next)).json()).toEqual({
    status: 'committed',
  })

  const { cwd } = await resolveShellDirectory(workspace('race'))
  await rm(path.join(cwd, 'attachments', 'notes.txt'))
  expect(await (await call('commit-copy', loser)).json()).toEqual({
    status: 'occupied',
  })
})

test('duplicates working files and permanently fences a deleted root', async () => {
  const sourceId = 'duplicate-source'
  const targetId = 'duplicate-target'
  const source = await resolveShellDirectory(workspace(sourceId))
  await writeFile(path.join(source.cwd, 'work.txt'), 'source')
  expect(
    (
      await call('duplicate', {
        sourceId,
        targetId,
        sessionIds: [sourceId],
        token: `${Date.now() + 30_000}:test`,
      })
    ).ok,
  ).toBe(true)
  const target = await resolveShellDirectory(workspace(targetId))
  await writeFile(path.join(target.cwd, 'work.txt'), 'target')
  expect(await readFile(path.join(source.cwd, 'work.txt'), 'utf8')).toBe(
    'source',
  )
  expect((await call('delete', { sessionId: sourceId })).ok).toBe(true)
  expect((await call('delete', { sessionId: sourceId })).ok).toBe(true)
  await expect(resolveShellDirectory(workspace(sourceId))).rejects.toThrow(
    'deleted',
  )
  expect(await readFile(path.join(target.cwd, 'work.txt'), 'utf8')).toBe(
    'target',
  )
})

test('provides the original PDF reference alongside an active preview', async () => {
  const ctx = {
    runQuery: async () => ({
      storageId: 'original',
      previewStorageId: 'preview',
      previewMediaType: 'image/jpeg',
      filename: 'scan.pdf',
      mediaType: 'application/pdf',
      byteLength: 99,
    }),
    storage: { get: async () => new Blob(['preview']) },
  } as never
  const part = {
    type: 'file',
    url: 'attachment:original',
    attachmentId: 'original',
  }
  const result = await resolveAttachmentHistoryParts(ctx, part, {
    mediaActive: true,
    copyEnabled: true,
    readerEnabled: false,
    toolMediaActive: false,
  })
  expect(result).toEqual([
    {
      type: 'text',
      text: expect.stringContaining('attachment:original/scan.pdf'),
    },
    {
      type: 'file',
      url: 'data:image/jpeg;base64,cHJldmlldw==',
      mediaType: 'image/jpeg',
      filename: 'scan.pdf',
    },
  ])
})

test('replays session notes only to agents with an effective file tool', () => {
  const note = {
    type: 'workspace',
    sender: { id: 'agent' },
    extra: {
      contextId: 'snapshot',
      sessionFiles: true,
      capabilities: ['copy_attachment'],
    },
  }
  expect(
    canReplayToolContext(
      note,
      ['read_attachment', 'task'],
      'agent',
      7,
      'snapshot',
    ),
  ).toBe(false)
  expect(
    canReplayToolContext(note, ['copy_attachment'], 'agent', 7, 'snapshot'),
  ).toBe(true)
  expect(
    canReplayToolContext(note, ['read_file'], 'other', 7, 'snapshot'),
  ).toBe(false)
})

test('a copy commit waits for an overlapping baseline and retries after release', async () => {
  const target = {
    sessionId: 'copy-fence',
    operationId: 'copy-fence',
    path: 'session://copy.txt',
  }
  const { workspace: copyWorkspace } = workspace(target.sessionId)
  const directory = await resolveShellDirectory(workspace(target.sessionId))
  await writeFile(path.join(directory.cwd, 'initial.txt'), 'held baseline')
  const copy = { ...target, url: storage.url.href, byteLength: original.length }
  expect((await call('stage-copy', copy)).ok).toBe(true)

  const checkpointStorage = new CheckpointBarrierStorage(
    path.join(root, 'copy-fence-checkpoints'),
    (text) => text === 'held baseline',
  )
  const manager = new CheckpointManager(checkpointStorage)
  const mock = spyOn(checkpointModule, 'checkpoints').mockReturnValue(manager)
  const write = manager.write.bind(manager)
  const reached = Promise.withResolvers<void>()
  const writeSpy = spyOn(manager, 'write').mockImplementation((...args) => {
    reached.resolve()
    return write(...args)
  })
  const owner = {
    sessionId: 'copy-fence-owner',
    groupId: 'copy-fence-owner',
    participantId: 'owner',
  }
  const paused = manager.begin({
    ...owner,
    workspace: {
      ...copyWorkspace,
      path: directory.cwd,
      sessionOnly: false,
      sessionFiles: false,
      sources: [{ id: 'shared', path: directory.cwd, label: 'Shared' }],
    },
  })

  let commit: ReturnType<typeof call> | undefined
  try {
    await checkpointDeadline(checkpointStorage.until(1))
    commit = call('commit-copy', target)
    await checkpointDeadline(reached.promise)
  } finally {
    checkpointStorage.release()
    await Promise.allSettled([paused, commit])
    writeSpy.mockRestore()
    mock.mockRestore()
  }

  expect(await paused).toEqual({ queued: false })
  expect((await commit)!.ok).toBe(false)
  const destination = path.join(directory.cwd, 'copy.txt')
  expect(await Bun.file(destination).exists()).toBe(false)
  await manager.finish({ ...owner, root: true, checkpointId: 'copy-fence' })
  expect((await call('commit-copy', target)).ok).toBe(true)
  expect(await readFile(destination)).toEqual(Buffer.from(original))
  await call('cleanup-transfer', {
    operationId: target.operationId,
    discardUpload: false,
  })
})
