import type { LanguageModelV4StreamPart } from '@ai-sdk/provider'
import { consumeProviderStep } from '@cv/convex/actions/stream/engineStep'
import { MockLanguageModelV4 } from 'ai/test'
import { expect, test } from 'bun:test'
import { getFunctionName } from 'convex/server'

type Step = Parameters<typeof consumeProviderStep>

const execution = { streamId: 'stream' as Step[1]['streamId'], generation: 1 }

function setupStep(languageModel: MockLanguageModelV4) {
  return {
    stream: { command: { kind: 'invoke' } },
    output: { _id: 'message', role: 'assistant', parts: [] },
    messages: [{ role: 'user', content: 'Hello' }],
    resolved: { languageModel },
  } as unknown as Step[2]
}

test('aborts the provider when an output patch loses stream ownership', async () => {
  let signal: AbortSignal | undefined
  const languageModel = new MockLanguageModelV4({
    doStream: async ({ abortSignal }) => {
      signal = abortSignal
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] })
            controller.enqueue({ type: 'text-start', id: 'answer' })
            controller.enqueue({
              type: 'text-delta',
              id: 'answer',
              delta: 'Hello',
            })
            abortSignal?.addEventListener('abort', () => controller.close(), {
              once: true,
            })
          },
        }),
      }
    },
  })
  const ctx = {
    runQuery: async () => true,
    runMutation: async (ref: Parameters<typeof getFunctionName>[0]) =>
      getFunctionName(ref) !== 'streams:_patchMessage',
  } as unknown as Step[0]
  const result = await consumeProviderStep(
    ctx,
    execution,
    setupStep(languageModel),
    Date.now() + 5_000,
  )
  expect(result.shouldContinue).toBeNull()
  expect(signal?.aborted).toBe(true)
})

test('flushes a throttled update while the provider is silent', async () => {
  let provider: ReadableStreamDefaultController<LanguageModelV4StreamPart>
  let signal: AbortSignal | undefined
  const languageModel = new MockLanguageModelV4({
    doStream: async ({ abortSignal }) => {
      signal = abortSignal
      return {
        stream: new ReadableStream({
          start(controller) {
            provider = controller
            controller.enqueue({ type: 'stream-start', warnings: [] })
            controller.enqueue({ type: 'text-start', id: 'answer' })
            controller.enqueue({
              type: 'text-delta',
              id: 'answer',
              delta: 'Hi',
            })
            abortSignal?.addEventListener('abort', () => controller.close(), {
              once: true,
            })
          },
        }),
      }
    },
  })
  const writes: string[] = []
  const ctx = {
    runQuery: async () => true,
    runMutation: async (
      ref: Parameters<typeof getFunctionName>[0],
      args: { parts: { type: string; text?: string }[] },
    ) => {
      if (getFunctionName(ref) !== 'streams:_patchMessage') return true
      const text = args.parts.find((part) => part.type === 'text')?.text
      if (!text) return true
      writes.push(text)
      if (text === 'Hi') {
        provider.enqueue({ type: 'text-delta', id: 'answer', delta: ' there' })
        return true
      }
      // A rejected timed write must cancel the still-open provider.
      return false
    },
  } as unknown as Step[0]

  const result = await consumeProviderStep(
    ctx,
    execution,
    setupStep(languageModel),
    Date.now() + 5000,
  )
  expect(writes).toEqual(['Hi', 'Hi there'])
  expect(result.shouldContinue).toBeNull()
  expect(signal?.aborted).toBe(true)
})
