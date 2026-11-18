import * as checkpointModule from '@cv/sidecar/checkpoints/manager'
import { CheckpointManager } from '@cv/sidecar/checkpoints/manager'
import { digest } from '@cv/sidecar/checkpoints/storage'
import { createApp } from '@cv/sidecar/main'
import { writeWorkspaceFile } from '@cv/sidecar/mcp/workspace/workspace'
import { afterEach, expect, spyOn, test } from 'bun:test'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  CheckpointBarrierStorage,
  checkpointDeadline,
} from '~/tests/helpers/checkpoint-barrier'
import { checkpointFixture } from '~/tests/helpers/turn-checkpoints'

const cleanup: string[] = []
afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

async function pausedFixture() {
  const f = await checkpointFixture(cleanup)
  const target = join(f.root, 'document')
  await writeFile(target, 'pause here')
  const storage = new CheckpointBarrierStorage(
    f.storage.root,
    (text) => text === 'pause here',
  )
  return { ...f, storage, target, manager: new CheckpointManager(storage) }
}

function otherCapture(id: string, ...roots: string[]) {
  return {
    groupId: id,
    participantId: id,
    sessionId: id,
    workspace: {
      workspaceId: id,
      path: roots[0],
      label: id,
      sources: roots.map((path, index) => ({
        id: String(index),
        path,
        label: id,
      })),
    },
  }
}

test('a multi-root waiter retains its place against an overlapping capture on its other root', async () => {
  const f = await pausedFixture()
  const nested = join(f.root, 'nested')
  const shared = join(f.base, 'shared')
  const independent = join(f.base, 'independent')
  await Promise.all([nested, shared, independent].map((root) => mkdir(root)))
  const multi = otherCapture('multi', shared, nested)
  const paused = f.manager.begin(f.begin)
  let waiting: ReturnType<typeof f.manager.begin> | undefined
  try {
    await checkpointDeadline(f.storage.until(1))
    waiting = f.manager.begin(multi)
    expect(
      await checkpointDeadline(
        f.manager.begin(otherCapture('independent', independent)),
      ),
    ).toEqual({ queued: false })
  } finally {
    f.storage.release()
    await Promise.allSettled([paused, waiting])
  }

  expect(await paused).toEqual({ queued: false })
  expect(await waiting).toEqual({ queued: true })
  await f.manager.finish(f.finish)
  const later = otherCapture('later', shared)
  expect(await f.manager.begin(later)).toEqual({ queued: true })
  await f.manager.finish({
    ...f.finish,
    ...multi,
    checkpointId: 'cancel-multi',
  })
  expect(await f.manager.begin(later)).toEqual({ queued: false })
})

test('external file writes, shell dispatch and restores respect a capture taking its baseline', async () => {
  const f = await checkpointFixture(cleanup)
  const target = join(f.root, 'document')
  const other = join(f.base, 'other')
  await mkdir(other)
  await writeFile(target, 'before')
  await f.manager.begin(f.begin)
  await writeFile(target, 'pause here')
  await f.manager.finish(f.finish)

  const storage = new CheckpointBarrierStorage(
    f.storage.root,
    (text) => text === 'pause here',
  )
  const manager = new CheckpointManager(storage)
  const mock = spyOn(checkpointModule, 'checkpoints').mockReturnValue(manager)
  const app = createApp((_, next) => next())
  const external = otherCapture('external', other)
  const paused = manager.begin(otherCapture('next', f.root))
  let write: ReturnType<typeof writeWorkspaceFile> | undefined
  let shell: Promise<Response> | undefined
  let restore: ReturnType<typeof manager.restore> | undefined
  try {
    await checkpointDeadline(storage.until(1))
    const context = {
      sessionId: external.sessionId,
      workspaceId: external.workspace.workspaceId,
      workspace: external.workspace,
      allowedPaths: [f.root],
    }
    write = writeWorkspaceFile({ ...context, filePath: target, content: 'bad' })
    shell = Promise.resolve(
      app.request('/shell/start', {
        method: 'POST',
        body: JSON.stringify({
          ...context,
          cwd: f.root,
          command: 'printf bad > document',
        }),
      }),
    )
    restore = manager.restore(f.restore)
  } finally {
    storage.release()
    await Promise.allSettled([paused, write, shell, restore])
    mock.mockRestore()
  }
  await expect(write!).rejects.toThrow('reserved')
  const response = (await shell)!
  expect(response.ok).toBe(false)
  expect(await response.text()).toContain('reserved')
  await expect(restore!).rejects.toThrow('workspace writers')
  expect(await paused).toEqual({ queued: false })
  expect(await readFile(target, 'utf8')).toBe('pause here')
})

test('session cleanup waits for a live baseline and preserves its blobs', async () => {
  const f = await pausedFixture()
  const capture = f.manager.begin(f.begin)
  let cleanupOperation: Promise<void> | undefined
  try {
    await checkpointDeadline(f.storage.until(1))
    expect(await f.manager.reserved(f.begin.sessionId)).toBe(true)
    cleanupOperation = f.manager.removeSession('unrelated-session')
  } finally {
    f.storage.release()
    await Promise.allSettled([capture, cleanupOperation])
  }
  await cleanupOperation
  expect(await capture).toEqual({ queued: false })
  expect(await f.storage.bytes(digest('pause here'))).toEqual(
    Buffer.from('pause here'),
  )
})

test('a failed baseline save releases its temporary claim and permits retry', async () => {
  const f = await checkpointFixture(cleanup)
  const mock = spyOn(f.storage, 'save').mockRejectedValueOnce(
    new Error('Disk failure'),
  )
  try {
    await expect(f.manager.begin(f.begin)).rejects.toThrow('Disk failure')
    expect(await f.manager.reserved(f.begin.sessionId)).toBe(false)
    expect(await f.manager.begin(f.begin)).toEqual({ queued: false })
  } finally {
    mock.mockRestore()
  }
})

test('immediate and duplicate finalization follow begin and preserve the child delta', async () => {
  const f = await checkpointFixture(cleanup)
  const parent = f.manager.begin(f.begin)
  const sealed = f.manager.finish({
    ...f.finish,
    pendingParticipants: ['child'],
  })
  expect(await parent).toEqual({ queued: false })
  expect((await sealed).released).toBe(false)

  await f.manager.begin({ ...f.begin, participantId: 'child', root: false })
  await writeFile(join(f.root, 'child'), 'content')
  const child = {
    ...f.finish,
    participantId: 'child',
    checkpointId: 'child',
    root: false,
  }
  const results = await Promise.all([
    f.manager.finish(child),
    f.manager.finish(child),
  ])
  expect(results[0]).toEqual(results[1])
  expect(results[0].publication?.files.map((file) => file.path)).toEqual([
    'child',
  ])
  expect(results[0].released).toBe(true)
})

test('extending a capture to an ancestor keeps the first before-state for covered files', async () => {
  const f = await checkpointFixture(cleanup)
  const alreadyCaptured = join(f.root, 'existing.txt')
  const created = join(f.root, 'added.txt')
  await writeFile(alreadyCaptured, 'original')
  await f.manager.begin(f.begin)
  await writeFile(alreadyCaptured, 'after')
  await writeFile(created, 'new')

  const ancestor = otherCapture('ancestor', f.base)
  await f.manager.begin({
    ...f.begin,
    workspace: ancestor.workspace,
    participantId: 'child',
    root: false,
  })
  await f.manager.finish(f.finish)
  const checkpoint = await f.manager.read(f.finish.checkpointId)
  const files = checkpoint?.files ?? []
  expect(
    files.find((file) => file.target === alreadyCaptured)?.before?.hash,
  ).toBe(digest('original'))
  expect(files.find((file) => file.target === created)?.before).toBeUndefined()
  expect(files.find((file) => file.target === created)?.after?.hash).toBe(
    digest('new'),
  )
})

test('simultaneous parent and child finishes publish each change once', async () => {
  const f = await checkpointFixture(cleanup)
  await f.manager.begin(f.begin)
  await f.manager.begin({ ...f.begin, participantId: 'child', root: false })
  await writeFile(join(f.root, 'document'), 'one change')
  const results = await Promise.all([
    f.manager.finish(f.finish),
    f.manager.finish({
      ...f.finish,
      participantId: 'child',
      checkpointId: 'child',
      root: false,
    }),
  ])
  expect(
    results.flatMap(
      (result) => result.publication?.files.map((file) => file.path) ?? [],
    ),
  ).toEqual(['document'])
  expect(results.map((result) => result.released)).toEqual([false, true])
})
