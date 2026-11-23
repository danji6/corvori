import type { LanguageModelV4StreamPart } from '@ai-sdk/provider'
import type { ActionCtx } from '@cv/convex/_generated/server'
import { prepare } from '@cv/convex/model/stream/engineSetup'
import {
  ProviderStreamFailure,
  consumeProviderStep,
} from '@cv/convex/model/stream/engineStep'
import type {
  StreamCommand,
  StreamExecutionArgs,
} from '@cv/convex/validators/streams'
import { evaluate } from '@cv/core/interpreter/evaluate'
import { createVariableStore } from '@cv/core/interpreter/store'
import type { EvalContext, JsonValue } from '@cv/core/interpreter/types'
import { modelReference } from '@cv/core/model-reference'
import type { Prompt, PromptItem } from '@cv/core/types/prompts'
import { simulateReadableStream, tool } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { expect, mock, spyOn, test } from 'bun:test'
import { getFunctionName } from 'convex/server'
import { z } from 'zod'

const execution = { streamId: 'stream', generation: 1 } as StreamExecutionArgs
const operations = ['compact', 'impersonate'] as const
const inputSchema = { type: 'object', properties: { term: { type: 'string' } } }
const wireInput = { name: 'docs_lookup', arguments: { term: 'example' } }

function prompt(id: string, content: string): Prompt {
  return {
    id,
    name: id,
    content,
    role: 'system',
    enabled: true,
    visible: false,
  }
}

function historyMessage(
  role: 'assistant' | 'user',
  id: string,
  parts: unknown[],
) {
  return {
    _id: id,
    role,
    sender:
      role === 'user'
        ? { type: 'user', id: 'user' }
        : { type: 'agent', id: 'agent' },
    senderName: role === 'user' ? 'Participant' : 'Agent',
    parts,
  }
}

const history = [
  historyMessage('user', 'previous', [{ type: 'text', text: 'Look this up' }]),
  historyMessage('assistant', 'answer', [
    {
      type: 'tool-docs_lookup',
      state: 'output-available',
      toolCallId: 'lookup-call',
      input: wireInput.arguments,
      output: 'A historical result',
      wireCall: { name: 'call_tool', input: wireInput },
    },
  ]),
  historyMessage('user', 'boundary', [{ type: 'text', text: 'Continue' }]),
]

type EvalInput = {
  items: PromptItem[]
  context: EvalContext
  environment: Record<string, JsonValue>
  authorizedAgentId?: string
}

function render({ items, context, environment }: EvalInput) {
  const store = createVariableStore(environment)
  return {
    items: items.map((item) =>
      'type' in item || !item.enabled
        ? item
        : { ...item, content: evaluate(item.content, context, store) },
    ),
    environment: store.toRecord(),
    dirty: store.isDirty(),
  }
}

function operationFixture(
  provider: 'openai' | 'chatgpt' | 'anthropic' | 'ollama' = 'openai',
) {
  const providerId = provider === 'chatgpt' ? 'openai' : provider
  const model = {
    id: provider === 'anthropic' ? 'claude-sonnet-4-6' : 'fixture-model',
    contextWindow: 0,
    trimContext: false,
  }
  const frozenManifest = {
    contextId: 'frozen-context',
    names: ['docs_lookup', 'call_tool'],
    definitions: [
      { name: 'docs_lookup', definitionRef: 'pinned', inputSchema: '' },
      {
        name: 'call_tool',
        description: 'Dispatch a tool',
        inputSchema: '{"type":"object"}',
      },
    ],
  }
  const cache = {
    promptEvaluationId: 'frozen',
    items: [prompt('agent', 'Frozen agent rules')],
    historyPresentation: { shareUserDisplayNames: true },
    tools: frozenManifest,
  }
  const operationPrompt = prompt(
    'operation',
    'Operation reads {{getVar("value")}}',
  )
  const data = {
    session: {
      _id: 'session',
      model: { id: modelReference('provider', model.id) },
    },
    stream: {
      ...execution,
      _id: execution.streamId,
      sessionId: 'session',
      agentId: 'agent',
      invokedBy: 'user',
      command: { kind: 'invoke' } as StreamCommand,
      state: { processingMessageId: 'output' },
    },
    output: { _id: 'output', role: 'assistant', parts: [] },
    agent: { _id: 'agent', name: 'Agent', tools: ['todo'] },
    invoker: { role: 'admin' },
    invokerSettings: { displayName: 'Current user' },
    owner: {},
    environment: { value: 'current state' },
    prompts: {
      own: [
        prompt(
          'agent',
          'Rules for {{user}} {{setVar("value", "captured state")}}',
        ),
      ],
      library: [],
      compaction: [operationPrompt],
      impersonation: [operationPrompt],
    },
    sessionCache: cache as typeof cache | null,
    mcpServers: [],
    modelProviders: [
      {
        id: providerId,
        auth: provider === 'chatgpt' ? 'chatgpt' : undefined,
        enabled: true,
        apiKey: 'fixture',
        baseURL: provider === 'ollama' ? 'http://ollama.fixture' : undefined,
        connectionId: 'provider',
        models: [model],
      },
    ],
  }
  const evaluations: EvalInput[] = []
  const runs = new Map<
    string,
    { items: PromptItem[]; result?: ReturnType<typeof render> }
  >()
  let evaluationCount = 0
  const rows = [...history]
  const writes: unknown[] = []
  const reads: unknown[] = []
  const cacheIds: string[] = []
  const patchedParts: unknown[] = []
  const bodies: Record<string, unknown>[] = []
  const ctx = {
    runQuery: async (
      ref: Parameters<typeof getFunctionName>[0],
      args: unknown,
    ) => {
      switch (getFunctionName(ref)) {
        case 'streams:_getContext':
          return data
        case 'streams:_getProviderHistory':
          return rows
        case 'streams:_getProviderHistorySnapshot':
          return {
            identity: 'history',
            completed: rows,
            live: { notes: [], current: null },
          }
        case 'promptEvaluations:_input': {
          const { id } = args as { id: string }
          const run = runs.get(id)
          return (
            run && {
              ...data,
              allowed: false,
              evaluation: { target: { kind: 'snapshot' } },
              items: run.items.map((item, index) => ({
                _id: String(index),
                item,
              })),
            }
          )
        }
        case 'promptEvaluations:_get':
          return { evaluation: { state: 'complete' } }
        case 'promptEvaluations:_result': {
          const { id } = args as { id: string }
          return id === cache.promptEvaluationId
            ? cache.items
            : runs.get(id)?.result?.items
        }
        case 'mcpCatalogs:_definitionAccess':
          reads.push(args)
      }
      return true
    },
    runMutation: async (
      ref: Parameters<typeof getFunctionName>[0],
      args: unknown,
    ) => {
      switch (getFunctionName(ref)) {
        case 'promptEvaluations:_reserve': {
          const id = String(++evaluationCount)
          runs.set(id, { items: (args as { items: PromptItem[] }).items })
          return id
        }
        case 'promptEvaluations:_pin':
          return { bootId: 'fixture', start: true }
        case 'promptEvaluations:_finish': {
          const run = runs.get((args as { id: string }).id)
          if (run?.result?.dirty)
            data.environment = run.result.environment as typeof data.environment
          break
        }
        case 'streams:_saveSessionCache':
          writes.push(args)
          break
        case 'streams:_patchMessage':
          patchedParts.push(args)
          break
        case 'streams:_resolveProviderCacheId':
          cacheIds.push((args as { prefixDigest: string }).prefixDigest)
          return data.session._id
        case 'streams:_prepareProviderRequest':
          return {}
      }
      return true
    },
    storage: {
      get: async (id: string) =>
        id === 'pinned'
          ? new Blob([
              JSON.stringify({
                name: 'lookup',
                description: 'Pinned lookup contract',
                inputSchema: JSON.stringify(inputSchema),
                metadata: '{}',
              }),
            ])
          : null,
      store: async () => 'log',
    },
  } as unknown as ActionCtx

  const fetch = spyOn(globalThis, 'fetch').mockImplementation((async (
    url: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const body = JSON.parse(String(init?.body))
    if (String(url).endsWith('/eval/operations/instance')) {
      return Response.json({ bootId: 'fixture' })
    }
    if (String(url).endsWith('/eval/operations/start')) {
      const run = runs.get(body.id)!
      const input = { ...body.input, items: run.items }
      evaluations.push(input)
      run.result = render(input)
      const texts = run.result.items.flatMap((item) =>
        'content' in item && item.enabled ? [item.content] : [],
      )
      return Response.json({ state: 'complete', result: { texts } })
    }
    if (String(url).endsWith('/eval/operations/acknowledge')) {
      return Response.json({ ok: true })
    }
    bodies.push(provider === 'chatgpt' ? body.body : body)
    return new Response('Captured provider request', { status: 400 })
  }) as typeof globalThis.fetch)
  const setup = async (command: StreamCommand) => {
    data.stream.command = command
    return (await prepare(ctx, execution))!
  }
  return {
    data,
    model,
    cache,
    ctx,
    setup,
    evaluations,
    writes,
    reads,
    rows,
    cacheIds,
    bodies,
    patchedParts,
    restore: () => fetch.mockRestore(),
  }
}

type Fixture = ReturnType<typeof operationFixture>
type Setup = Awaited<ReturnType<Fixture['setup']>>

async function capture(fixture: Fixture, setup: Setup) {
  const index = fixture.bodies.length
  await expect(
    consumeProviderStep(fixture.ctx, execution, setup, Date.now() + 5_000),
  ).rejects.toBeInstanceOf(ProviderStreamFailure)
  expect(fixture.bodies).toHaveLength(index + 1)
  return fixture.bodies[index]!
}

test.each(operations)(
  '%s captures only the chat prefix on a cache miss',
  async (kind) => {
    const f = operationFixture()
    try {
      f.data.sessionCache = null
      f.data.agent.tools = ['read_file']
      const request = await f.setup({
        kind,
        instructions: '  Command instruction  ',
      })
      expect(request.systemPrompt).toContain('Rules for Current user')
      expect(request.messages.slice(-2)).toEqual([
        { role: 'system', content: 'Operation reads captured state' },
        { role: 'user', content: 'Command instruction' },
      ])
      expect(
        f.evaluations.map(({ items }) =>
          items.map((item) => 'id' in item && item.id),
        ),
      ).toEqual([['agent'], ['operation']])
      expect(f.evaluations[0]).toMatchObject({
        authorizedAgentId: 'agent',
        context: { tools: ['read_file'] },
      })
      expect(f.evaluations[1]).toMatchObject({ context: { tools: [] } })
      expect(f.evaluations[1]?.authorizedAgentId).toBeUndefined()
      expect(f.data.environment).toEqual({ value: 'captured state' })
      expect(f.writes).toEqual([
        expect.objectContaining({
          promptEvaluationId: '1',
          tools: expect.objectContaining({
            names: ['read_file', 'get_tool', 'call_tool'],
          }),
          historyPresentation: {
            maskOtherAgents: false,
            shareUserDisplayNames: false,
            shareAgentDisplayNames: false,
          },
        }),
      ])
      expect(request.tools).toEqual({})
      expect(request.toolRuntime).toBeUndefined()
    } finally {
      f.restore()
    }
  },
)

test.each(['openai', 'chatgpt', 'anthropic', 'ollama'] as const)(
  '%s serializes the same prefix and pinned tools for chat and both operations',
  async (provider) => {
    const f = operationFixture(provider)
    try {
      const setup = await f.setup({ kind: 'invoke' })
      expect(f.cacheIds).toEqual([])
      const chat = await capture(f, setup)
      const messagesKey =
        provider === 'openai' || provider === 'chatgpt' ? 'input' : 'messages'
      const historyPrefix = chat[messagesKey] as unknown[]
      expect(JSON.stringify(chat)).toContain('Frozen agent rules')
      expect(JSON.stringify(historyPrefix)).toContain('Participant: Continue')
      expect(JSON.stringify(historyPrefix)).toContain('A historical result')
      expect(JSON.stringify(historyPrefix)).toContain('call_tool')
      expect(JSON.stringify(historyPrefix)).toContain('docs_lookup')
      expect(JSON.stringify(chat.tools)).toContain('Pinned lookup contract')
      expect(JSON.stringify(chat.tools)).toContain(JSON.stringify(inputSchema))
      if (provider === 'chatgpt') {
        expect(chat.tools).toEqual([
          expect.objectContaining({ type: 'namespace', name: 'corvori' }),
        ])
      }
      if (provider === 'anthropic') {
        expect(JSON.stringify(historyPrefix)).toContain('cache_control')
      }
      if (provider === 'ollama') {
        expect(historyPrefix).toContainEqual({
          role: 'tool',
          tool_name: 'call_tool',
          content: 'A historical result',
        })
      }

      for (const kind of operations) {
        const request = await f.setup({
          kind,
          instructions: 'Command instruction',
        })
        const body = await capture(f, request)
        expect(body.tools).toEqual(chat.tools)
        expect(body.system).toEqual(chat.system)
        expect(body.instructions).toEqual(chat.instructions)
        const messages = body[messagesKey] as unknown[]
        expect(messages.slice(0, historyPrefix.length)).toEqual(historyPrefix)
        const trailing = JSON.stringify(messages.slice(historyPrefix.length))
        expect(trailing).toContain('Operation reads current state')
        expect(trailing.indexOf('Command instruction')).toBeGreaterThan(
          trailing.indexOf('Operation reads current state'),
        )
        expect(body.tool_choice).toEqual(
          provider === 'ollama'
            ? undefined
            : provider === 'anthropic'
              ? chat.tool_choice
              : 'none',
        )
      }
      expect(f.evaluations.map((evalInput) => evalInput.items)).toEqual(
        operations.map(() => f.data.prompts.compaction),
      )
      expect(f.writes).toEqual([])
      expect(f.reads).toEqual(
        Array.from({ length: 3 }, () => ({
          ...execution,
          definitionRef: 'pinned',
        })),
      )
      if (provider === 'chatgpt') {
        f.rows.push(
          historyMessage('user', 'follow-up', [
            { type: 'text', text: 'Follow up' },
          ]),
        )
        await capture(f, await f.setup({ kind: 'invoke' }))
        expect(f.cacheIds).toHaveLength(4)
        expect(new Set(f.cacheIds).size).toBe(1)
      } else {
        expect(f.cacheIds).toEqual([])
      }
    } finally {
      f.restore()
    }
  },
)

test('Anthropic keeps the operation system text after a systemless chat prefix', async () => {
  const f = operationFixture('anthropic')
  try {
    f.cache.items = []
    const chat = await capture(f, await f.setup({ kind: 'invoke' }))
    const body = await capture(f, await f.setup({ kind: 'compact' }))
    expect(body.system).toBeUndefined()
    const blocks = (body.messages as { content: unknown[] }[]).flatMap(
      ({ content }) => content,
    )
    const prefix = (chat.messages as { content: unknown[] }[]).flatMap(
      ({ content }) => content,
    )
    expect(blocks.slice(0, prefix.length)).toEqual(prefix)
    expect(blocks.slice(prefix.length)).toEqual([
      { type: 'text', text: 'Operation reads current state' },
    ])
  } finally {
    f.restore()
  }
})

test('operation instructions trim whole turns only when needed to fit', async () => {
  const f = operationFixture()
  try {
    f.model.contextWindow = 500
    f.model.trimContext = true
    const chat = await f.setup({ kind: 'invoke' })
    const request = await f.setup({
      kind: 'impersonate',
      instructions: 'Continue in the same voice',
    })
    expect(JSON.stringify(chat.messages)).toContain('Look this up')
    expect(request.messages.slice(0, -2)).toEqual(chat.messages)
    const trimmed = await f.setup({
      kind: 'impersonate',
      instructions: 'long '.repeat(390),
    })
    const retained = JSON.stringify(trimmed.messages)
    expect(retained).not.toContain('Look this up')
    expect(retained).not.toContain('A historical result')
    expect(retained).toContain('Continue')
    expect(retained).toContain('long '.repeat(389))

    await expect(
      f.setup({ kind: 'compact', instructions: 'long '.repeat(600) }),
    ).rejects.toMatchObject({ data: { code: 413 } })
    expect(f.bodies).toHaveLength(0)
  } finally {
    f.restore()
  }
})

test.each([true, false])(
  'an Anthropic operation never executes or continues on a tool-calls finish (call emitted: %s)',
  async (emitsCall) => {
    const f = operationFixture('anthropic')
    try {
      const request = await f.setup({ kind: 'compact' })
      const execute = mock(async () => 'unexpected execution')
      request.tools.docs_lookup = tool({ inputSchema: z.object({}), execute })
      const output: LanguageModelV4StreamPart[] = emitsCall
        ? [
            {
              type: 'tool-call',
              toolCallId: 'unexpected',
              toolName: 'docs_lookup',
              input: '{}',
            },
          ]
        : [
            { type: 'text-start', id: 'summary' },
            { type: 'text-delta', id: 'summary', delta: 'Summary' },
            { type: 'text-end', id: 'summary' },
          ]
      const model = new MockLanguageModelV4({
        doStream: async () => ({
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              ...output,
              {
                type: 'finish',
                finishReason: { unified: 'tool-calls', raw: undefined },
                usage: {
                  inputTokens: {
                    total: 1,
                    noCache: 1,
                    cacheRead: 0,
                    cacheWrite: 0,
                  },
                  outputTokens: { total: 1, text: 1, reasoning: 0 },
                },
              },
            ],
          }),
        }),
      })
      const result = consumeProviderStep(
        f.ctx,
        execution,
        { ...request, resolved: { languageModel: model } },
        Date.now() + 5_000,
      )
      if (emitsCall) {
        await expect(result).rejects.toBeInstanceOf(ProviderStreamFailure)
      } else {
        await expect(result).resolves.toMatchObject({ shouldContinue: false })
      }
      expect(model.doStreamCalls).toHaveLength(1)
      expect(model.doStreamCalls[0]?.toolChoice).toEqual({ type: 'auto' })
      expect(execute).not.toHaveBeenCalled()
      expect(JSON.stringify(f.patchedParts)).not.toContain('unexpected')
    } finally {
      f.restore()
    }
  },
)
