import type { ModelMessage } from '@ai-sdk/provider-utils'
import type { ActionCtx } from '@cv/convex/_generated/server'
import { prepare } from '@cv/convex/model/stream/engineSetup'
import { consumeProviderStep } from '@cv/convex/model/stream/engineStep'
import { trimProviderHistory } from '@cv/convex/model/stream/trimHistory'
import { modelReference } from '@cv/core/model-reference'
import type { AgentModelOverride, ModelEntry } from '@cv/core/types'
import { expect, spyOn, test } from 'bun:test'
import { getFunctionName } from 'convex/server'

const execution = { streamId: 'stream' as never, generation: 0 }
const baseModel = modelReference('provider', 'gpt-5')
const fixedModel = modelReference('provider', 'gpt-5-mini')

function requestFixture(override?: AgentModelOverride) {
  const rows = [
    { role: 'user', text: 'old '.repeat(120) },
    { role: 'assistant', text: 'Previous answer.' },
    { role: 'user', text: 'Current input one.' },
    { role: 'user', text: 'Current input two.' },
    { role: 'assistant', text: 'Work in progress.' },
  ].map(({ role, text }, index) => ({
    _id: `message-${index}`,
    role,
    sender:
      role === 'user'
        ? { type: 'user', id: 'user' }
        : { type: 'agent', id: 'agent' },
    parts: [{ type: 'text', text }],
  }))
  const models: ModelEntry[] = [
    { id: 'gpt-5', outputTokens: 512 },
    {
      id: 'gpt-5-mini',
      outputTokens: 128,
      contextWindow: 64,
      trimContext: true,
    },
  ]
  const data = {
    session: { _id: 'session', model: { id: baseModel } },
    agent: { _id: 'agent', modelOverride: override },
    stream: {
      _id: 'stream',
      sessionId: 'session',
      agentId: 'agent',
      command: { kind: 'retry' },
      state: { processingMessageId: 'output' },
    },
    invoker: { role: 'user' },
    owner: {},
    output: { _id: 'output', parts: [], role: 'assistant' },
    environment: {},
    userCount: 1,
    agentCount: 1,
    prompts: {
      own: [
        {
          id: 'system',
          name: 'System',
          role: 'system',
          content: 'Configured instruction',
          enabled: true,
        },
      ],
      library: [],
    },
    mcpServers: [],
    modelProviders: [
      {
        id: 'openai',
        apiKey: 'fixture',
        connectionId: 'provider',
        enabled: true,
        models,
      },
    ],
  }
  const ctx = {
    runQuery: async (ref: Parameters<typeof getFunctionName>[0]) => {
      const name = getFunctionName(ref)
      if (name === 'streams:_getContext') return data
      if (name === 'streams:_getProviderHistory') return rows
      return 'active'
    },
    runMutation: async () => true,
    storage: { store: async () => 'fixture-log' },
  } as unknown as ActionCtx
  return { ctx, rows, models }
}

test('uses the effective model’s limits and reasoning on a retry', async () => {
  const requests: Record<string, unknown>[] = []
  const fetch = spyOn(globalThis, 'fetch').mockImplementation((async (
    url: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    if (String(url).endsWith('/eval/prompts')) {
      return Response.json({
        items: [
          {
            role: 'system',
            enabled: true,
            content: 'Configured instruction',
          },
        ],
        environment: {},
        dirty: false,
      })
    }
    requests.push(JSON.parse(String(init?.body)))
    return new Response('data: [DONE]\n\n', {
      headers: { 'Content-Type': 'text/event-stream' },
    })
  }) as typeof globalThis.fetch)
  try {
    const base = requestFixture()
    const fixed = requestFixture({
      modelId: fixedModel,
      reasoningEffort: 'high',
    })
    for (const fixture of [base, fixed]) {
      const setup = (await prepare(fixture.ctx, execution))!
      // The mock response ends without model output after capturing the request.
      await expect(
        consumeProviderStep(fixture.ctx, execution, setup, Date.now() + 5_000),
      ).rejects.toThrow()
    }
    expect(requests).toMatchObject([
      { model: 'gpt-5', max_output_tokens: 512 },
      {
        model: 'gpt-5-mini',
        max_output_tokens: 128,
        reasoning: { effort: 'high' },
      },
    ])
    expect(JSON.stringify(requests[0])).toContain('Previous answer.')
    const trimmed = JSON.stringify(requests[1])
    expect(trimmed).not.toContain('Previous answer.')
    expect(trimmed).toContain('Configured instruction')
    expect(trimmed).toContain('Current input one.')
    expect(trimmed).toContain('Current input two.')
    expect(trimmed).toContain('Work in progress.')
    expect(fixed.rows).toHaveLength(5)
  } finally {
    fetch.mockRestore()
  }
})

test('fails an unavailable override without using the composer model', async () => {
  const { ctx, models } = requestFixture({ modelId: fixedModel })
  models[1].available = false
  await expect(prepare(ctx, execution)).rejects.toMatchObject({
    data: {
      message: expect.stringContaining(
        'model override "gpt-5-mini" is unavailable',
      ),
    },
  })
})

test('trims whole historical tool exchanges and keeps the active exchange and approval note', async () => {
  const exchange = (id: string, text: string): ModelMessage[] => [
    { role: 'user', content: text },
    {
      role: 'assistant',
      content: [
        { type: 'tool-call', toolCallId: id, toolName: 'lookup', input: {} },
      ],
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: id,
          toolName: 'lookup',
          output: { type: 'text', value: 'result' },
        },
      ],
    },
  ]
  const active = exchange('current-call', 'Latest input')
  const prepared = await trimProviderHistory(
    [...exchange('old-call', 'old '.repeat(80)), ...active],
    { contextWindow: 32, messages: [], tools: {} },
    new Map([['current-call', 'Approved current work']]),
  )
  expect(prepared.slice(0, 3)).toEqual(active)
  expect(prepared[3]).toMatchObject({
    role: 'user',
    content: [
      { type: 'text', text: expect.stringContaining('Approved current work') },
    ],
  })
  expect(prepared).toHaveLength(4)
})
