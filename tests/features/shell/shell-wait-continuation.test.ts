import { finalizeMessageParts } from '@cv/convex/model/messages'
import {
  bindReference,
  findReference,
  removeShellReferences,
} from '@cv/convex/model/shellReferences'
import { finishShellWait, pendingShellWaits } from '@cv/convex/model/shellWaits'
import { expect, test } from 'bun:test'
import { lifecycleDatabase } from '~/tests/helpers/lifecycle-db'

const execution = { streamId: 'stream' as never, generation: 2 }
const jobId = 'shell-legacy-uuid'
const input = { jobId: '1' }
const running = {
  jobId,
  jobNumber: 1,
  status: 'running',
  exitCode: null,
  text: '',
  term: 'working\n',
  termOffset: 0,
  waitUntil: 1234,
} as const
const read = {
  type: 'tool-shell_output',
  state: 'output-available',
  toolCallId: 'read',
  input,
  output: running,
}

test('a resumed generation settles a wait at most once', async () => {
  const { ctx, rows } = lifecycleDatabase({
    sessions: [{ _id: 'chat' }],
    streams: [
      {
        _id: 'stream',
        generation: 2,
        sessionId: 'chat',
        state: {
          phase: 'streaming',
          processingMessageId: 'reply',
          processingContentId: 'content',
        },
      },
    ],
    messages: [
      {
        _id: 'reply',
        sessionId: 'chat',
        status: 'processing',
        selectedVersion: 1,
      },
    ],
    messageContents: [
      {
        _id: 'content',
        messageId: 'reply',
        version: 1,
        segmentIndex: 0,
        parts: [read],
      },
    ],
  })

  expect(await pendingShellWaits(ctx, execution)).toMatchObject({
    parts: [read],
  })
  const { waitUntil: _deadline, ...initial } = running
  const output = {
    ...initial,
    status: 'done',
    exitCode: 0,
    text: 'done\n',
  } as const
  const completion = { ...execution, toolCallId: 'read', output }
  expect(await finishShellWait(ctx, { ...completion, generation: 1 })).toBe(
    false,
  )
  expect(await finishShellWait(ctx, completion)).toBe(true)
  expect(await finishShellWait(ctx, completion)).toBe(false)
  expect(await pendingShellWaits(ctx, execution)).toBeNull()
  expect(rows('messageContents')[0].parts).toMatchObject([
    { preliminary: false, output },
  ])
})

test('a stopped wait is saved as a cancelled read', () => {
  const [part] = finalizeMessageParts([read])
  expect(part).toMatchObject({
    state: 'output-error',
    input,
    errorText: 'Shell output wait was cancelled.',
  })
  expect(part).not.toHaveProperty('output')
})

test('jobs share chat numbers across child agents and numbers are not recycled', async () => {
  const { ctx } = lifecycleDatabase({
    sessions: [
      { _id: 'chat' },
      { _id: 'child', parent: { sessionId: 'chat' } },
    ],
    messages: [
      { _id: 'first', sessionId: 'child', selectedVersion: 2 },
      { _id: 'second', sessionId: 'chat', selectedVersion: 1 },
    ],
  })
  const base = {
    sessionId: 'chat',
    toolCallId: 'call',
    command: 'pwd',
  } as never
  const origin = { ...(base as object), messageId: 'first', jobId } as never

  expect(await bindReference(ctx, origin)).toBe(1)
  expect(await bindReference(ctx, origin)).toBe(1)
  const number = await findReference(ctx, {
    sessionId: 'chat' as never,
    jobId: '1',
  })
  expect(number).toMatchObject({ jobId, version: 2, messageId: 'first' })
  await removeShellReferences(ctx, 'first' as never, 2)
  expect(
    await bindReference(ctx, {
      ...(base as object),
      messageId: 'second',
      jobId: 'shell-2',
    } as never),
  ).toBe(2)
  expect(
    await findReference(ctx, { sessionId: 'chat' as never, jobId }),
  ).toBeNull()
})
