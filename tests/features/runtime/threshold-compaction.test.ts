import type { ModelMessage } from '@ai-sdk/provider-utils'
import type { Id } from '@cv/convex/_generated/dataModel'
import type { ActionCtx } from '@cv/convex/_generated/server'
import {
  autoCompact,
  runScheduledEvent,
  timeout,
} from '@cv/convex/model/chat/scheduling'
import { sendMessage } from '@cv/convex/model/chat/send'
import { insertMessage } from '@cv/convex/model/messageContents'
import { _stream } from '@cv/convex/model/stream/engine'
import {
  compactBeforeDispatch,
  reachesCompactionThreshold,
} from '@cv/convex/model/stream/engineCompaction'
import * as EngineSetup from '@cv/convex/model/stream/engineSetup'
import { _claim } from '@cv/convex/model/stream/lifecycleClaims'
import { _saveMeta } from '@cv/convex/model/stream/lifecycleMeta'
import {
  _complete,
  _fail,
  _finalizeStopped,
} from '@cv/convex/model/stream/lifecycleTerminal'
import {
  _getProviderHistory,
  _getStopState,
  _hasActiveMedia,
} from '@cv/convex/model/stream/reads'
import { _compactAtThreshold } from '@cv/convex/model/stream/thresholdCompaction'
import type {
  StreamExecutionArgs,
  ThresholdCompactionArgs,
} from '@cv/convex/validators/streams'
import { messagePosition } from '@cv/core/message-position'
import { modelReference } from '@cv/core/model-reference'
import { tool } from 'ai'
import { expect, mock, spyOn, test } from 'bun:test'
import { getFunctionName } from 'convex/server'
import { z } from 'zod'
import { skillsDatabase } from '~/tests/helpers/skills-db'

const sessionId = 'session' as Id<'sessions'>
const userId = 'owner' as Id<'users'>
const agentId = 'agent' as Id<'agents'>
const modelId = modelReference('provider', 'model')
const contextWindow = 10
const usage = { inputTokens: 9, outputTokens: 1, totalTokens: 10 }
const atThreshold = ' word'.repeat(9)

test('checks estimated input at 90% and includes textual tool payloads and schemas', async () => {
  const request = { messages: [], tools: {} }
  expect(
    await reachesCompactionThreshold(
      { ...request, systemPrompt: atThreshold },
      contextWindow,
    ),
  ).toBe(true)
  const media: ModelMessage = {
    role: 'user',
    content: [{ type: 'image', image: 'A'.repeat(10_000) }],
  }
  expect(
    await reachesCompactionThreshold(
      { ...request, messages: [media] },
      contextWindow,
    ),
  ).toBe(false)
  expect(
    await reachesCompactionThreshold(
      { ...request, systemPrompt: ' word'.repeat(8) },
      contextWindow,
    ),
  ).toBe(false)
  const result: ModelMessage = {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: 'call',
        toolName: 'lookup',
        output: { type: 'text', value: atThreshold },
      },
    ],
  }
  expect(
    await reachesCompactionThreshold(
      { ...request, messages: [result] },
      contextWindow,
    ),
  ).toBe(true)
  const tools = {
    lookup: tool({ description: atThreshold, inputSchema: z.object({}) }),
  }
  expect(
    await reachesCompactionThreshold({ ...request, tools }, contextWindow),
  ).toBe(true)
})

async function fixture({ withHistory = true, withMedia = false } = {}) {
  const state = skillsDatabase()
  const { db, ctx, rows } = state
  let clock = 10
  const insert = db.insert
  db.insert = (table, fields) =>
    insert(table, { _creationTime: clock++, ...fields })
  Object.assign(db, {
    normalizeId: (table: string, id: string) =>
      rows(table).some((row) => row._id === id) ? id : null,
  })
  Object.assign(ctx.scheduler, {
    runAt: ctx.scheduler.runAfter,
    cancel: async () => {},
  })
  rows('sessions').push({
    _id: sessionId,
    ownerId: userId,
    activeAgentId: agentId,
    model: { id: modelId, contextWindow },
  })
  rows('agents').push({ _id: agentId, ownerId: userId, name: 'Agent' })
  rows('sessionAgents').push({ _id: 'link', sessionId, agentId })
  rows('userSessions').push({ _id: 'member', sessionId, userId, role: 'owner' })
  rows('modelProviders').push({
    _id: 'provider',
    ownerId: userId,
    enabled: true,
    models: [{ id: 'model', contextWindow }],
  })
  const prior = withHistory
    ? (
        await insertMessage(
          ctx,
          {
            sessionId,
            sender: { type: 'agent', id: agentId },
            role: 'assistant',
            status: 'done',
          },
          [{ type: 'text', text: 'Earlier answer' }],
        )
      ).messageId
    : undefined
  const attachmentId = 'attachment' as Id<'attachments'>
  if (withMedia) {
    rows('attachments').push({
      _id: attachmentId,
      sessionId,
      uploaderId: userId,
      fileId: 'file',
      filename: 'input.png',
      mediaType: 'image/png',
    })
  }
  const input = await sendMessage(ctx, {
    sessionId,
    content: 'Unread question',
    attachments: withMedia ? [{ id: attachmentId }] : undefined,
  })
  const execution = {
    streamId: rows('streams')[0]._id as Id<'streams'>,
    generation: 1,
  }
  const threshold = { ...execution, modelId, contextWindow }
  return { ...state, input, prior, execution, threshold }
}

type Fixture = Awaited<ReturnType<typeof fixture>>

async function current(f: Fixture) {
  const stream = (await f.ctx.db.get(f.execution.streamId))!
  return {
    stream,
    execution: { streamId: stream._id, generation: stream.generation },
  }
}

async function completeSummary(f: Fixture, execution: StreamExecutionArgs) {
  const compact = (await f.ctx.db.get(execution.streamId))!
  const messageId = compact.state.processingMessageId!
  await f.ctx.db.patch(compact.state.processingContentId!, {
    parts: [{ type: 'text', text: 'Summary of earlier history.' }],
  })
  await _complete(f.ctx, execution)
  return messageId
}

test('uses the override in the threshold guard and defers to explicitly queued compaction when trimming', async () => {
  const f = await fixture()
  const overrideId = modelReference('provider', 'override')
  await f.ctx.db.patch(agentId, { modelOverride: { modelId: overrideId } })
  await f.ctx.db.patch('provider' as never, {
    models: [{ id: 'override', contextWindow, trimContext: true }],
  })
  const claimed = (await _claim(f.ctx, f.execution))!
  const transition = mock()
  const action = { runMutation: transition } as unknown as ActionCtx
  expect(
    await compactBeforeDispatch(action, f.execution, {
      stream: claimed,
      modelId: overrideId,
      contextWindow,
      trimContext: true,
      systemPrompt: atThreshold,
      messages: [],
      tools: {},
    }),
  ).toBe(false)
  expect(transition).not.toHaveBeenCalled()

  // A threshold check prepared before trimming was enabled hands off for a fresh request.
  expect(
    await _compactAtThreshold(f.ctx, { ...f.threshold, modelId: overrideId }),
  ).toBe(true)
  const running = await current(f)
  expect(running.stream.command.kind).toBe('invoke')
  const reloaded = (await _claim(f.ctx, running.execution))!
  await autoCompact(f.ctx, { sessionId })
  await f.ctx.db.patch(reloaded.state.processingContentId!, {
    parts: [{ type: 'text', text: 'Finished reply' }],
  })
  await _complete(f.ctx, running.execution)
  expect(f.rows('streams')[0]?.command).toMatchObject({
    kind: 'compact',
    autoCompact: true,
  })
})

test('preempts normal dispatch, consumes the one-shot, and resumes with unread media and queued inputs', async () => {
  const f = await fixture({ withMedia: true })
  await autoCompact(f.ctx, { sessionId })
  const queuedPosition = f
    .rows('messages')
    .find((row) => row.type === 'command')?.position

  const model = {
    doStream: mock(() => {
      throw new Error('Invocation dispatched before the summary')
    }),
  }
  const prepare = spyOn(EngineSetup, 'prepare').mockImplementation(
    async () =>
      ({
        stream: (await current(f)).stream,
        modelId,
        contextWindow,
        messages: [],
        tools: {},
        systemPrompt: atThreshold,
        resolved: { languageModel: model },
      }) as unknown as NonNullable<
        Awaited<ReturnType<typeof EngineSetup.prepare>>
      >,
  )
  const action = {
    runQuery: (
      ref: Parameters<typeof getFunctionName>[0],
      args: StreamExecutionArgs,
    ) => {
      if (getFunctionName(ref) === 'streams:_getStopState')
        return _getStopState(f.ctx, args)
      if (getFunctionName(ref) === 'shellJobs:_pendingWaits') return null
      return []
    },
    runMutation: (
      ref: Parameters<typeof getFunctionName>[0],
      args: ThresholdCompactionArgs,
    ) => {
      if (getFunctionName(ref) === 'streams:_claim') return _claim(f.ctx, args)
      if (getFunctionName(ref) === 'streams:_compactAtThreshold')
        return _compactAtThreshold(f.ctx, args)
      throw new Error(`Unexpected mutation ${getFunctionName(ref)}`)
    },
  } as unknown as ActionCtx
  try {
    await _stream(action, f.execution)
  } finally {
    prepare.mockRestore()
  }

  expect(model.doStream).not.toHaveBeenCalled()
  const compact = await current(f)
  expect(compact.stream).toMatchObject({
    generation: 2,
    command: { kind: 'compact', autoCompact: true },
    contextBoundaryMessageId: f.prior,
  })
  expect(f.rows('scheduledEvents')).toHaveLength(0)
  const [oneShot, ...extraChips] = f
    .rows('messages')
    .filter((message) => message.type === 'command')
  expect(oneShot?.extra).toMatchObject({ status: 'ran' })
  expect(oneShot?.position).toBe(queuedPosition)
  expect(extraChips).toHaveLength(0)
  expect(await _compactAtThreshold(f.ctx, f.threshold)).toBe(true)
  expect((await current(f)).execution).toEqual(compact.execution)

  const arrival = await sendMessage(f.ctx, {
    sessionId,
    content: 'Sent during compaction',
  })
  await _claim(f.ctx, compact.execution)
  expect(
    (await _getProviderHistory(f.ctx, compact.execution)).map((row) => row._id),
  ).toEqual([f.prior!])
  await f.ctx.db.patch(compact.execution.streamId, { omitActiveMedia: true })
  const summary = await completeSummary(f, compact.execution)

  const resumed = await current(f)
  expect(f.rows('streams')).toHaveLength(1)
  expect(resumed.stream.omitActiveMedia).toBeUndefined()
  expect(resumed.stream).toMatchObject({
    generation: 3,
    command: { kind: 'invoke', skipThresholdCompaction: true },
  })
  const claimed = await _claim(f.ctx, resumed.execution)
  const history = await _getProviderHistory(f.ctx, resumed.execution)
  expect(history.map((row) => row._id)).toEqual([summary, f.input, arrival])
  expect(await _hasActiveMedia(f.ctx, resumed.execution)).toBe(true)
  expect(f.rows('notifications')).toHaveLength(0)

  const transition = mock()
  const request = {
    stream: claimed!,
    modelId,
    systemPrompt: atThreshold,
    messages: [],
    tools: {},
  }
  const actionWithoutDispatch = {
    runMutation: transition,
  } as unknown as ActionCtx
  expect(
    await compactBeforeDispatch(actionWithoutDispatch, resumed.execution, {
      ...request,
      contextWindow,
    }),
  ).toBe(false)

  await _saveMeta(f.ctx, {
    ...resumed.execution,
    duration: 1,
    toolErrors: [],
    warnings: [],
    usage,
  })
  const nextStep = { ...request, stream: (await current(f)).stream }
  expect(
    await compactBeforeDispatch(
      actionWithoutDispatch,
      resumed.execution,
      nextStep,
    ),
  ).toBe(false)
  expect(transition).not.toHaveBeenCalled()
  await compactBeforeDispatch(actionWithoutDispatch, resumed.execution, {
    ...nextStep,
    contextWindow,
  })
  expect(transition).toHaveBeenCalledTimes(1)
})

test.each([false, true])(
  'keeps task attribution through compaction unless interrupted by a new prompt (manual input: %s)',
  async (interrupted) => {
    const f = await fixture()
    const runId = 'run' as Id<'scheduledTaskRuns'>
    f.rows('scheduledTasks').push({
      _id: 'task',
      ownerId: userId,
      state: 'active',
      activeRunId: runId,
    })
    f.rows('scheduledTaskRuns').push({
      _id: runId,
      taskId: 'task',
      sessionId,
      status: 'running',
      title: 'Mailbox',
      agentName: 'Agent',
    })
    await f.ctx.db.patch(f.execution.streamId, { taskRunId: runId })
    const manual = interrupted
      ? await sendMessage(f.ctx, { sessionId, content: 'Manual request' })
      : undefined
    const pending = await current(f)
    const claimed = (await _claim(f.ctx, pending.execution))!
    if (manual) {
      expect(claimed.taskRunId).toBeUndefined()
      expect(f.rows('scheduledTaskRuns')[0].status).toBe('failed')
      await f.ctx.db.patch(claimed.state.processingContentId!, {
        parts: [{ type: 'text', text: 'Partial response' }],
      })
    }
    expect(
      await _compactAtThreshold(f.ctx, {
        ...f.threshold,
        ...pending.execution,
      }),
    ).toBe(true)
    const compact = await current(f)
    await _claim(f.ctx, compact.execution)
    const summaryInput = await _getProviderHistory(f.ctx, compact.execution)
    if (manual) expect(summaryInput.map((row) => row._id)).toContain(manual)
    else expect(summaryInput.map((row) => row._id)).toEqual([f.prior!])
    const summary = await completeSummary(f, compact.execution)
    const resumed = await current(f)
    const active = (await _claim(f.ctx, resumed.execution))!
    const input = await _getProviderHistory(f.ctx, resumed.execution)
    expect(input.map((row) => row._id)).toEqual(
      manual ? [summary] : [summary, f.input],
    )
    expect(active.taskRunId).toEqual(manual ? undefined : runId)
    await _complete(f.ctx, resumed.execution)
    expect(
      f
        .rows('notifications')
        .filter((row) => row.taskRunId)
        .map((row) => row.kind),
    ).toEqual([manual ? 'task_failed' : 'task_succeeded'])
    expect(f.rows('streams')).toHaveLength(0)
  },
)

test('seals settled tool output into the summary and resumes without requiring new input', async () => {
  const f = await fixture({ withHistory: false })
  const parentId = await f.ctx.db.insert('sessions', { ownerId: userId })
  await f.ctx.db.patch(sessionId, {
    parent: {
      sessionId: parentId,
      streamId: f.execution.streamId,
      agentId,
      toolCallId: 'task',
    },
  })
  const claimed = (await _claim(f.ctx, f.execution))!
  expect(await _compactAtThreshold(f.ctx, f.threshold)).toBe(false)
  const pending = {
    type: 'tool-lookup',
    state: 'approval-responded',
    toolCallId: 'call',
  }
  await f.ctx.db.patch(claimed.state.processingContentId!, { parts: [pending] })
  expect(await _compactAtThreshold(f.ctx, f.threshold)).toBe(false)
  const commandChips = () =>
    f.rows('messages').filter((message) => message.type === 'command')
  expect(commandChips()).toHaveLength(0)
  const settled = {
    ...pending,
    state: 'output-available',
    input: {},
    output: 'Result',
  }
  await f.ctx.db.patch(claimed.state.processingContentId!, { parts: [settled] })
  expect(await _compactAtThreshold(f.ctx, f.threshold)).toBe(true)
  expect(await _compactAtThreshold(f.ctx, f.threshold)).toBe(true)
  const compact = await current(f)
  const summaryPlaceholder = (await f.ctx.db.get(
    compact.stream.state.processingMessageId!,
  ))!
  expect(commandChips()).toEqual([
    expect.objectContaining({
      hidden: true,
      contextEligible: false,
      extra: {
        name: 'autoCompact',
        source: 'contextWindow',
        status: 'ran',
      },
    }),
  ])
  expect(String(commandChips()[0].position) < summaryPlaceholder.position).toBe(
    true,
  )
  expect(await f.ctx.db.get(claimed.state.processingMessageId)).toMatchObject({
    status: 'done',
  })
  expect(compact.stream.contextBoundaryMessageId).toBe(
    claimed.state.processingMessageId,
  )

  await _claim(f.ctx, compact.execution)
  const history = await _getProviderHistory(f.ctx, compact.execution)
  expect(history.at(-1)?.parts).toEqual([settled])
  const summary = await completeSummary(f, compact.execution)
  expect(
    f.rows('messages').filter((row) => row.sessionId === parentId),
  ).toHaveLength(0)
  const resumed = await current(f)
  const reply = (await _claim(f.ctx, resumed.execution))!
  expect(
    (await _getProviderHistory(f.ctx, resumed.execution)).map((row) => row._id),
  ).toEqual([summary])
  await f.ctx.db.patch(reply.state.processingContentId!, {
    parts: [{ type: 'text', text: 'Task complete.' }],
  })
  await _complete(f.ctx, resumed.execution)
  expect(
    f.rows('messages').filter((row) => row.sessionId === parentId),
  ).toHaveLength(1)
})

test('reprepares the invocation when the saved model limit changes during estimation', async () => {
  const f = await fixture()
  await _claim(f.ctx, f.execution)
  await f.ctx.db.patch('provider' as Id<'modelProviders'>, {
    models: [{ id: 'model' }],
  })
  expect(await _compactAtThreshold(f.ctx, f.threshold)).toBe(true)
  expect((await current(f)).stream).toMatchObject({
    command: { kind: 'invoke' },
    generation: f.execution.generation + 1,
    state: { phase: 'pending' },
  })
})

test.each(['failure', 'timeout'] as const)(
  'terminates on summary %s and leaves original context available',
  async (outcome) => {
    const f = await fixture()
    const original = (await _claim(f.ctx, f.execution))!
    const anchor = (await f.ctx.db.get(original.state.processingMessageId!))!
    const { messageId: noteId } = await insertMessage(
      f.ctx,
      {
        sessionId,
        sender: { type: 'agent', id: agentId },
        role: 'system',
        status: 'done',
        type: 'skills',
        hidden: true,
        extra: { fingerprint: 'skills', anchorMessageId: anchor._id },
      },
      [{ type: 'text', text: 'Available skills' }],
      { anchor, kind: 'contextNote' },
    )
    expect((await f.ctx.db.get(noteId))!.position < anchor.position).toBe(true)
    if (outcome === 'timeout')
      await timeout(f.ctx, { sessionId, duration: '0' })
    expect(await _compactAtThreshold(f.ctx, f.threshold)).toBe(true)
    const compact = await current(f)
    expect(compact.stream.state.processingMessageId).toBe(anchor._id)
    const note = (await f.ctx.db.get(noteId))!
    expect(note.extra).toMatchObject({ anchorMessageId: undefined })
    expect(note.position).toBe(messagePosition(note))
    expect(f.rows('messages')).toContainEqual(
      expect.objectContaining({
        type: 'command',
        extra: expect.objectContaining({
          source: 'contextWindow',
        }),
      }),
    )
    const chip = f
      .rows('messages')
      .find(
        (row) => (row.extra as { source?: string })?.source === 'contextWindow',
      )!
    expect(String(chip.position) < anchor.position).toBe(true)
    const summary = (await _claim(f.ctx, compact.execution))!
    await f.ctx.db.patch(summary.state.processingContentId!, {
      parts: [{ type: 'text', text: 'Partial summary' }],
    })

    if (outcome === 'timeout') {
      const eventId = f.rows('scheduledEvents')[0]._id as Id<'scheduledEvents'>
      await runScheduledEvent(f.ctx, { eventId })
      await _complete(f.ctx, compact.execution)
      await _finalizeStopped(f.ctx, compact.execution)
    } else {
      await _fail(f.ctx, { ...compact.execution, message: 'Provider failed' })
    }

    expect(f.rows('streams')).toHaveLength(0)
    expect(await f.ctx.db.get(summary.state.processingMessageId)).toMatchObject(
      { status: 'done', type: undefined, contextEligible: false },
    )
    const nextInput = await sendMessage(f.ctx, {
      sessionId,
      content: 'Try again',
    })
    const execution = {
      streamId: f.rows('streams')[0]._id as Id<'streams'>,
      generation: 1,
    }
    await _claim(f.ctx, execution)
    expect(
      (await _getProviderHistory(f.ctx, execution)).map((row) => row._id),
    ).toEqual([f.prior!, f.input, noteId, nextInput])
  },
)
