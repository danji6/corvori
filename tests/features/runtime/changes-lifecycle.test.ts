import { markChangesStale } from '@cv/convex/model/changes/locations'
import {
  appendChanges,
  captureIssue,
  changeSummary,
  finishChanges,
  prepareChanges,
  publishChanges,
  releaseChangeGroup,
  reservePublication,
  restoreChanges,
  restoreResult,
} from '@cv/convex/model/changes/sets'
import { describe, expect, test } from 'bun:test'
import { lifecycleDatabase } from '~/tests/helpers/lifecycle-db'

const workspace = {
  workspaceId: 'workspace',
  path: '/project',
  label: 'Project',
  sources: [{ id: 'primary', path: '/project', label: 'Project' }],
}
function fixture() {
  const database = lifecycleDatabase({
    sessions: [{ _id: 'session', ownerId: 'owner' }],
    users: [{ _id: 'owner', subject: 'owner-subject', role: 'admin' }],
    agents: [{ _id: 'agent', ownerId: 'owner', name: 'Agent' }],
    userSessions: [
      {
        _id: 'membership',
        sessionId: 'session',
        userId: 'owner',
        role: 'owner',
      },
    ],
    messages: [
      {
        _id: 'message',
        sessionId: 'session',
        selectedVersion: 1,
        versionCount: 1,
      },
    ],
    streams: [
      {
        _id: 'stream',
        generation: 1,
        sessionId: 'session',
        agentId: 'agent',
        state: { phase: 'streaming', processingMessageId: 'message' },
      },
    ],
  })
  Object.assign(database.ctx, { userId: 'owner', role: 'admin' })
  return database
}
const file = (key: string) => ({
  file: {
    key,
    path: `${key}.ts`,
    kind: 'modified' as const,
    additions: 1,
    deletions: 1,
    binary: false,
    truncated: false,
  },
  diffStorageId: `blob-${key}` as never,
})
const prepareArgs = { streamId: 'stream' as never, generation: 1, workspace }

describe('changes lifecycle', () => {
  test('reserves one identity across continuations and rejects obsolete executions', async () => {
    const f = fixture()
    const first = (await prepareChanges(f.ctx, prepareArgs))!
    const repeated = (await prepareChanges(f.ctx, prepareArgs))!
    expect(first._id).toBe(repeated._id)
    expect(f.rows('changeSets')).toHaveLength(1)
    expect(
      await prepareChanges(f.ctx, { ...prepareArgs, generation: 0 }),
    ).toBeNull()
    expect(f.rows('messages')[0].hasChanges).toBe(true)
  })

  test('publishes batches idempotently and deduplicates a retried late publication', async () => {
    const f = fixture()
    const row = (await prepareChanges(f.ctx, prepareArgs))!
    const id = (await reservePublication(f.ctx, {
      changeSetId: row._id,
      checkpointId: String(row._id),
      late: false,
    }))!
    await appendChanges(f.ctx, { changeSetId: id, files: [file('one')] })
    await appendChanges(f.ctx, {
      changeSetId: id,
      files: [file('one'), file('two')],
    })
    expect(f.rows('changeFiles')).toHaveLength(2)
    expect(f.deletedStorage).toContain('blob-one')
    await expect(
      publishChanges(f.ctx, {
        changeSetId: id,
        fileCount: 3,
        additions: 2,
        deletions: 2,
        issues: [],
      }),
    ).rejects.toThrow('incomplete')
    await publishChanges(f.ctx, {
      changeSetId: id,
      fileCount: 2,
      additions: 2,
      deletions: 2,
      issues: [],
    })
    expect(f.rows('changeSets')[0].phase).toBe('ready')
    const lateArgs = { changeSetId: id, checkpointId: 'later', late: true }
    expect(await reservePublication(f.ctx, lateArgs)).toBe(
      await reservePublication(f.ctx, lateArgs),
    )
    expect(f.rows('changeSets')).toHaveLength(2)
  })

  test('authorizes restores, deduplicates pending clicks and fences stale results', async () => {
    const f = fixture()
    const row = (await prepareChanges(f.ctx, prepareArgs))!
    await appendChanges(f.ctx, { changeSetId: row._id, files: [file('one')] })
    await publishChanges(f.ctx, {
      changeSetId: row._id,
      fileCount: 1,
      additions: 1,
      deletions: 1,
      issues: [],
    })
    f.rows('changeSets')[0].issues = ['Skipped an unreadable file']
    await releaseChangeGroup(f.ctx, { groupId: row.groupId })
    expect(
      (
        await changeSummary(f.ctx, {
          messageId: 'message' as never,
          version: 1,
        })
      )?.canRestore,
    ).toBe(true)
    const args = {
      changeSetId: row._id,
      revision: 0,
      direction: 'revert' as const,
    }
    Object.assign(f.ctx, { userId: 'stranger' })
    await expect(restoreChanges(f.ctx, args)).rejects.toThrow()
    Object.assign(f.ctx, { userId: 'owner' })
    await restoreChanges(f.ctx, args)
    await restoreChanges(f.ctx, args)
    expect(f.scheduled).toHaveLength(1)
    const operationId = String(f.rows('changeSets')[0].operationId)
    await restoreResult(f.ctx, {
      changeSetId: row._id,
      operationId: 'obsolete',
      state: 'reverted',
      revision: 1,
    })
    expect(f.rows('changeSets')[0].state).toBe('applied')
    await restoreResult(f.ctx, {
      changeSetId: row._id,
      operationId,
      issues: ['Skipped an unwritable file'],
      state: 'reverted',
      revision: 1,
    })
    expect(f.rows('changeSets')[0].state).toBe('reverted')
    expect(f.rows('changeSets')[0].issues).toEqual([
      'Skipped an unwritable file',
    ])
    await expect(restoreChanges(f.ctx, args)).rejects.toThrow('changed')
  })

  test('finalizes stopped participants without capture rows and releases controls after all writers settle', async () => {
    const f = fixture()
    const row = (await prepareChanges(f.ctx, prepareArgs))!
    f.rows('streams').push({ _id: 'child', changeGroupId: String(row.groupId) })
    await finishChanges(f.ctx, 'child' as never)
    expect(f.scheduled[0].args).toMatchObject({
      changeSetId: row._id,
      participantId: 'child',
    })
    await finishChanges(f.ctx, 'stream' as never)
    await finishChanges(f.ctx, 'stream' as never)
    expect(f.scheduled).toHaveLength(2)
    await releaseChangeGroup(f.ctx, { groupId: row.groupId })
    expect(f.rows('changeSets')[0].writersSettled).toBe(true)
  })

  test('marks only the checked location stale and keeps published diffs available', async () => {
    const f = fixture()
    const row = (await prepareChanges(f.ctx, prepareArgs))!
    await appendChanges(f.ctx, { changeSetId: row._id, files: [file('one')] })
    await publishChanges(f.ctx, {
      changeSetId: row._id,
      fileCount: 1,
      additions: 1,
      deletions: 1,
      issues: [],
    })
    await releaseChangeGroup(f.ctx, { groupId: row.groupId })
    const summaryArgs = { messageId: 'message' as never, version: 1 }
    const ready = (await changeSummary(f.ctx, summaryArgs))!
    const args = { changeSetId: row._id, subject: 'owner-subject' }
    expect(await markChangesStale(f.ctx, { ...args, locationKey: 'old' })).toBe(
      false,
    )
    expect(
      await markChangesStale(f.ctx, {
        ...args,
        locationKey: ready.locationKey!,
      }),
    ).toBe(true)
    expect(await changeSummary(f.ctx, summaryArgs)).toMatchObject({
      phase: 'stale',
      canRestore: false,
      fileCount: 1,
    })
    expect(f.rows('changeFiles')).toHaveLength(1)
    await expect(
      restoreChanges(f.ctx, {
        changeSetId: row._id,
        revision: 0,
        direction: 'reapply',
      }),
    ).rejects.toThrow('changed location')
  })

  test('hides warning-only publications, including existing ready summaries with no files', async () => {
    const f = fixture()
    const row = (await prepareChanges(f.ctx, prepareArgs))!
    await publishChanges(f.ctx, {
      changeSetId: row._id,
      fileCount: 0,
      additions: 0,
      deletions: 0,
      issues: ['Permission denied in an unrelated directory'],
    })
    expect(f.rows('changeSets')[0].phase).toBe('empty')
    const args = { messageId: 'message' as never, version: 1 }
    expect(await changeSummary(f.ctx, args)).toBeNull()
    f.rows('changeSets')[0].phase = 'ready'
    expect(await changeSummary(f.ctx, args)).toBeNull()
  })

  test('hides pending captures until files are recorded', async () => {
    const f = fixture()
    const row = (await prepareChanges(f.ctx, prepareArgs))!
    await finishChanges(f.ctx, prepareArgs.streamId)

    const args = { messageId: 'message' as never, version: 1 }
    expect(await changeSummary(f.ctx, args)).toBeNull()

    await appendChanges(f.ctx, {
      changeSetId: row._id,
      files: [file('one')],
    })
    expect(await changeSummary(f.ctx, args)).toMatchObject({
      phase: 'capturing',
      fileCount: 1,
    })

    await publishChanges(f.ctx, {
      changeSetId: row._id,
      fileCount: 1,
      additions: 1,
      deletions: 1,
      issues: [],
    })
    expect(await changeSummary(f.ctx, args)).toMatchObject({
      phase: 'ready',
      fileCount: 1,
    })
  })

  test('keeps capture failures visible instead of publishing a false empty summary', async () => {
    const f = fixture()
    const row = (await prepareChanges(f.ctx, prepareArgs))!
    await captureIssue(f.ctx, {
      changeSetId: row._id,
      message: 'Storage unavailable',
    })
    expect(f.rows('changeSets')[0]).toMatchObject({
      phase: 'unavailable',
      error: 'Storage unavailable',
    })
    expect(
      await changeSummary(f.ctx, { messageId: 'message' as never, version: 1 }),
    ).toMatchObject({ phase: 'unavailable', error: 'Storage unavailable' })
    await expect(
      restoreChanges(f.ctx, {
        changeSetId: row._id,
        revision: 0,
        direction: 'revert',
      }),
    ).rejects.toThrow('unavailable')
  })
})
