import type { SnapshotTiming } from '@cv/sidecar/checkpoints/coordination'
import { CheckpointManager } from '@cv/sidecar/checkpoints/manager'
import { CheckpointStorage, digest } from '@cv/sidecar/checkpoints/storage'
import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CheckpointBarrierStorage,
  checkpointDeadline,
} from '~/tests/helpers/checkpoint-barrier'

import { createReport, percentiles } from './report'

const FILES = 100
const BYTES = 1024
const WARMUPS = 2
const ROUNDS = 10
const { record, writeReport } = createReport('checkpoints')

async function createTurn(base: string, index: number, files = FILES) {
  const id = `turn-${index}`
  const root = join(base, id)
  const target = join(root, '000.txt')
  const before = (file: number) => `${id}-${file}`.padEnd(BYTES, 'x')
  await mkdir(root)
  await Promise.all(
    Array.from({ length: files }, (_, file) =>
      writeFile(
        join(root, `${String(file).padStart(3, '0')}.txt`),
        before(file),
      ),
    ),
  )
  const workspace = {
    workspaceId: id,
    path: root,
    label: id,
    sources: [{ id, path: root, label: id }],
  }
  return {
    target,
    before: before(0),
    after: 'edited ' + id,
    begin: { workspace, sessionId: id, groupId: id, participantId: id },
    finish: { checkpointId: id, groupId: id, participantId: id, root: true },
  }
}

type Turn = Awaited<ReturnType<typeof createTurn>>

async function runTurn(manager: CheckpointManager, turn: Turn) {
  const started = performance.now()
  assert.equal((await manager.begin(turn.begin)).queued, false)
  const beginMs = performance.now() - started

  await manager.write(turn.begin.sessionId, [turn.target], async (writer) => {
    await writer.trackFile(turn.target, turn.begin.workspace)
    await writeFile(turn.target, turn.after)
  })
  const finishing = performance.now()
  const result = await manager.finish(turn.finish)
  assert.equal(result.released, true)
  return { beginMs, finishMs: performance.now() - finishing }
}

async function verifyTurn(manager: CheckpointManager, turn: Turn) {
  const checkpoint = await manager.read(turn.finish.checkpointId)
  assert.deepEqual(
    checkpoint?.files.map(({ target, before, after }) => ({
      target,
      before: before?.hash,
      after: after?.hash,
    })),
    [
      {
        target: turn.target,
        before: digest(turn.before),
        after: digest(turn.after),
      },
    ],
  )
}

async function withFixture<T>(run: (base: string) => Promise<T>) {
  const base = await mkdtemp(join(tmpdir(), 'corvori-checkpoint-perf-'))
  try {
    return await run(base)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

async function round(turns: number, concurrency: number) {
  return withFixture(async (base) => {
    const fixture = await Promise.all(
      Array.from({ length: turns }, (_, index) => createTurn(base, index)),
    )
    const scans: SnapshotTiming[] = []
    const manager = new CheckpointManager(
      new CheckpointStorage(join(base, 'store')),
      {
        concurrency,
        onTiming: (sample) => scans.push(sample),
      },
    )
    const started = performance.now()
    const results = await Promise.allSettled(
      fixture.map((turn) => runTurn(manager, turn)),
    )
    const batchMs = performance.now() - started
    const samples = results.map((result) => {
      if (result.status === 'rejected') throw result.reason
      return result.value
    })
    await Promise.all(fixture.map((turn) => verifyTurn(manager, turn)))
    return { samples, scans, batchMs }
  })
}

async function benchmark(turns: number, concurrency: number) {
  const rounds = []
  for (let index = -WARMUPS; index < ROUNDS; index++) {
    const result = await round(turns, concurrency)
    if (index >= 0) rounds.push(result)
  }
  const samples = rounds.flatMap((sample) => sample.samples)
  const scans = rounds.flatMap((sample) => sample.scans)
  const batch = rounds.map((sample) => sample.batchMs)
  const scansFor = (phase: SnapshotTiming['phase']) => {
    const entries = scans.filter((entry) => entry.phase === phase)
    return {
      admissionWait: percentiles(entries.map((entry) => entry.waitMs)),
      scan: percentiles(entries.map((entry) => entry.scanMs)),
    }
  }
  record({
    scenario: 'disjoint-turns',
    turns,
    scanLimit: concurrency,
    filesPerTurn: FILES,
    bytesPerFile: BYTES,
    warmups: WARMUPS,
    rounds: ROUNDS,
    begin: {
      ...percentiles(samples.map((sample) => sample.beginMs)),
      ...scansFor('begin'),
    },
    finish: {
      ...percentiles(samples.map((sample) => sample.finishMs)),
      ...scansFor('finish'),
    },
    batch: percentiles(batch),
    turnsPerSecond: +(
      (1000 * samples.length) /
      batch.reduce((a, b) => a + b, 0)
    ).toFixed(1),
    peakScans: Math.max(...scans.map((scan) => scan.concurrent)),
  })
}

const deadline = <T>(operation: Promise<T>) =>
  checkpointDeadline(operation, 10_000)

async function independentCaptures() {
  await withFixture(async (base) => {
    const first = await createTurn(base, 0, 1)
    const other = await createTurn(base, 1, 1)
    const storage = new CheckpointBarrierStorage(
      join(base, 'store'),
      (text) => text === first.before,
    )
    const manager = new CheckpointManager(storage)
    const paused = manager.begin(first.begin)
    let contender: ReturnType<typeof manager.begin> | undefined
    let disjoint: ReturnType<typeof runTurn> | undefined
    try {
      await deadline(storage.until(1))
      contender = manager.begin({
        ...first.begin,
        sessionId: 'contender',
        groupId: 'contender',
      })
      disjoint = runTurn(manager, other)
      await deadline(disjoint)
      await verifyTurn(manager, other)
    } finally {
      storage.release()
      await Promise.allSettled([paused, contender, disjoint])
    }
    assert.deepEqual(await paused, { queued: false })
    assert.deepEqual(await contender, { queued: true })
    record({
      scenario: 'independent-capture',
      disjointCompletedWhilePaused: true,
      overlappingQueued: true,
    })
  })
}

async function checkScanLimit() {
  await withFixture(async (base) => {
    const turns = await Promise.all(
      Array.from({ length: 8 }, (_, index) => createTurn(base, index, 1)),
    )
    const storage = new CheckpointBarrierStorage(join(base, 'store'), (text) =>
      text.startsWith('turn-'),
    )
    const scans: SnapshotTiming[] = []
    const manager = new CheckpointManager(storage, {
      onTiming: (sample) => scans.push(sample),
    })
    const pending = turns.map((turn) => runTurn(manager, turn))
    try {
      await deadline(storage.until(4))
      assert.equal(storage.count, 4)
    } finally {
      storage.release()
      await Promise.allSettled(pending)
    }
    await Promise.all(pending)
    await Promise.all(turns.map((turn) => verifyTurn(manager, turn)))
    const peak = Math.max(...scans.map((scan) => scan.concurrent))
    assert.equal(peak, 4)
    record({ scenario: 'scan-limit', turns: turns.length, peakScans: peak })
  })
}

export async function runCheckpoints() {
  try {
    await independentCaptures()
    await checkScanLimit()
    for (const turns of [1, 4, 8]) {
      for (const limit of [1, 4]) await benchmark(turns, limit)
    }
    await writeReport()
  } catch (error) {
    await writeReport(error)
    throw error
  }
}
