import type { Id } from '@cv/convex/_generated/dataModel'
import { providerPrefixDigest } from '@cv/convex/model/stream/providerCacheId'
import { resolveProviderCacheId } from '@cv/convex/model/stream/providerRequests'
import type { Prompt, PromptItem } from '@cv/convex/types'
import { expect, test } from 'bun:test'

import { lifecycleDatabase } from '../../helpers/lifecycle-db'

function prompt(content: string): Prompt {
  return {
    id: content,
    name: content,
    role: 'user',
    content,
    enabled: true,
    visible: false,
  }
}

function routingFixture() {
  const stream = {
    _id: 'stream' as Id<'streams'>,
    sessionId: 'session' as Id<'sessions'>,
    agentId: 'agent-a',
    generation: 1,
    state: { phase: 'streaming' },
  }
  const { ctx, rows } = lifecycleDatabase({ streams: [stream] })
  const resolve = async (
    systemPrompt: string,
    generation = stream.generation,
  ) =>
    resolveProviderCacheId(ctx, {
      streamId: stream._id,
      generation,
      prefixDigest: await providerPrefixDigest({
        sessionId: stream.sessionId,
        systemPrompt,
        remainingPrompts: [],
        wireDefinitions: [],
      }),
    })
  return { stream, resolve, rows }
}

test('keeps the original route warm and isolates different prefixes after switching agents', async () => {
  const { stream, resolve } = routingFixture()
  expect(await resolve('Original rules')).toBe(stream.sessionId)
  expect(await resolve('Updated rules')).toBe(stream.sessionId)

  stream.agentId = 'agent-b'
  const secondRoute = await resolve('Different rules')
  expect(secondRoute).toMatch(/^[a-f0-9]{64}$/)
  stream.generation++
  expect(await resolve('Different rules')).toBe(secondRoute)

  stream.agentId = 'agent-a'
  expect(await resolve('Updated rules')).toBe(stream.sessionId)
  expect(await resolve('Different rules')).toBe(secondRoute)
  expect(await resolve('Original rules')).not.toBe(stream.sessionId)

  stream.sessionId = 'other-session' as Id<'sessions'>
  expect(await resolve('Updated rules')).toBe(stream.sessionId)
  stream.agentId = 'agent-b'
  expect(await resolve('Different rules')).not.toBe(secondRoute)
})

test('shares identical prefixes across agents and rejects stale attempts to change the baseline', async () => {
  const { stream, resolve, rows } = routingFixture()
  expect(await resolve('Same rules')).toBe(stream.sessionId)
  const baseline = rows('sessionState')[0]?.cacheId
  stream.agentId = 'agent-b'
  stream.generation++

  await expect(resolve('Stale rules', 1)).rejects.toMatchObject({
    data: { code: 409 },
  })
  expect(rows('sessionState')[0]?.cacheId).toEqual(baseline)
  expect(await resolve('Same rules')).toBe(stream.sessionId)
  expect(await resolve('Changed rules')).not.toBe(stream.sessionId)
})

test('hashes ordered provider tool contracts and rendered prompts before history', async () => {
  const marker: PromptItem = { type: 'message-history' }
  const lookup = {
    name: 'lookup',
    description: 'Looks up a record',
    inputSchema: '{"type":"object"}',
  }
  const otherTool = { ...lookup, name: 'search' }
  const prefix = {
    sessionId: 'session' as Id<'sessions'>,
    systemPrompt: 'System rules',
    remainingPrompts: [prompt('Before history'), marker, prompt('After')],
    wireDefinitions: [lookup, otherTool],
  }
  const digest = await providerPrefixDigest(prefix)
  expect(
    await providerPrefixDigest({
      ...prefix,
      remainingPrompts: [
        { ...prompt('Before history'), id: 'another-id' },
        marker,
        prompt('Different suffix'),
      ],
    }),
  ).toBe(digest)
  for (const change of [
    { remainingPrompts: [prompt('Edited before history'), marker] },
    { wireDefinitions: [otherTool, lookup] },
    { wireDefinitions: [{ ...lookup, inputSchema: '{}' }, otherTool] },
  ]) {
    expect(await providerPrefixDigest({ ...prefix, ...change })).not.toBe(
      digest,
    )
  }
})
