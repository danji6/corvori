import type { ActionCtx } from '@cv/convex/_generated/server'
import { finishChanges as finalizeCapture } from '@cv/convex/model/changes/actions'
import {
  continueFinalization,
  reconcileFinishedChanges,
} from '@cv/convex/model/changes/finalization'
import { markChangesStale } from '@cv/convex/model/changes/locations'
import {
  appendChanges,
  captureIssue,
  changeSummary,
  finishChanges,
  finishContext,
  prepareChanges,
  publishChanges,
  releaseChangeGroup,
  reservePublication,
  restoreChanges,
  restoreResult,
  settleCapture,
} from '@cv/convex/model/changes/sets'
import { CheckpointManager } from '@cv/sidecar/checkpoints/manager'
import { describe, expect, spyOn, test } from 'bun:test'
import { getFunctionName } from 'convex/server'
import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { lifecycleDatabase } from '~/tests/helpers/lifecycle-db'
import { checkpointFixture } from '~/tests/helpers/turn-checkpoints'

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

function finalizerAction(f: ReturnType<typeof fixture>) {
  const mutations = {
    'chat:_appendChanges': appendChanges,
    'chat:_captureChangesIssue': captureIssue,
    'chat:_continueChangesFinalization': continueFinalization,
    'chat:_publishChanges': publishChanges,
    'chat:_releaseChangeGroup': releaseChangeGroup,
    'chat:_reserveChangesPublication': reservePublication,
    'chat:_settleChangesCapture': settleCapture,
  }
  const ctx = {
    runQuery: (
      reference: Parameters<typeof getFunctionName>[0],
      args: never,
    ) => {
      expect(getFunctionName(reference)).toBe('chat:_changesFinishContext')
      return finishContext(f.ctx, args)
    },
    runMutation: (
      reference: Parameters<typeof getFunctionName>[0],
      args: never,
    ) =>
      mutations[getFunctionName(reference) as keyof typeof mutations](
        f.ctx,
        args,
      ),
    storage: { store: async () => 'fixture-diff' },
  } as unknown as ActionCtx
  return ctx
}

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

  test('replays a lost finalizer after restart so the next session can use the workspace', async () => {
    const cleanup: string[] = []
    const f = fixture()
    try {
      const sidecar = await checkpointFixture(cleanup)
      const row = (await prepareChanges(f.ctx, {
        ...prepareArgs,
        workspace: sidecar.begin.workspace,
      }))!
      const capture = {
        ...sidecar.begin,
        groupId: row.groupId,
        participantId: String(row.streamId),
      }
      await sidecar.manager.begin(capture)
      await writeFile(path.join(sidecar.root, 'change.txt'), 'old turn output')
      await finishChanges(f.ctx, row.streamId)
      f.rows('streams').pop()

      const recovered = new CheckpointManager(sidecar.storage)
      const nextTurn = {
        ...capture,
        sessionId: 'moved-session',
        groupId: 'next-turn',
        participantId: 'next-turn',
      }
      expect(await recovered.begin(nextTurn)).toEqual({ queued: true })

      await reconcileFinishedChanges(f.ctx, {})
      expect(f.scheduled).toHaveLength(1)
      f.rows('_scheduled_functions')[0].state = { kind: 'inProgress' }
      await reconcileFinishedChanges(f.ctx, {})
      expect(f.scheduled).toHaveLength(1)
      f.rows('_scheduled_functions')[0].state = { kind: 'failed' }
      await reconcileFinishedChanges(f.ctx, {})
      expect(f.scheduled).toHaveLength(2)
      expect(f.scheduled[1].args).toEqual({ changeSetId: row._id })

      const finishEndpoint = async (
        url: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        expect(String(url)).toEndWith('/checkpoints/finish')
        const input = JSON.parse(String(init?.body))
        return Response.json(await recovered.finish(input))
      }
      const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
        Object.assign(finishEndpoint, { preconnect: fetch.preconnect }),
      )
      try {
        await finalizeCapture(finalizerAction(f), { changeSetId: row._id })
      } finally {
        fetchSpy.mockRestore()
      }

      expect(row).toMatchObject({ phase: 'ready', writersSettled: true })
      expect(f.rows('changeFiles')).toHaveLength(1)
      expect(await recovered.begin(nextTurn)).toEqual({ queued: false })
      await reconcileFinishedChanges(f.ctx, {})
      expect(f.scheduled).toHaveLength(2)
    } finally {
      await Promise.all(
        cleanup.map((root) => rm(root, { recursive: true, force: true })),
      )
    }
  })

  test('recovers legacy settlement only after the owning stream has ended', async () => {
    const f = fixture()
    const row = (await prepareChanges(f.ctx, prepareArgs))!
    Object.assign(row, { finished: true, settleScheduled: true })
    await reconcileFinishedChanges(f.ctx, {})
    expect(f.scheduled).toHaveLength(0)

    f.rows('streams').pop()
    await reconcileFinishedChanges(f.ctx, {})
    expect(f.scheduled[0].args).toEqual({ changeSetId: row._id, sequence: 0 })
    const scheduled = row.finalizationJobId
    await continueFinalization(f.ctx, { changeSetId: row._id })
    expect(f.scheduled).toHaveLength(1)

    f.rows('_scheduled_functions')[0].state = { kind: 'inProgress' }
    await continueFinalization(f.ctx, {
      changeSetId: row._id,
      expectedJobId: scheduled,
      settlementSequence: 0,
    })
    expect(f.scheduled).toHaveLength(2)
    expect(row.finalizationJobId).not.toBe(scheduled)
    await reconcileFinishedChanges(f.ctx, {})
    expect(f.scheduled).toHaveLength(2)
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
