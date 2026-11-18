'use node'

import { internalAction } from '@cv/convex/_generated/server'
import type { prepare as prepareProvider } from '@cv/convex/actions/stream/engineSetup'
import type { ProviderHistorySnapshot } from '@cv/convex/actions/stream/historySnapshot'
import {
  type ApiFromModules,
  type FunctionArgs,
  makeFunctionReference,
} from 'convex/server'
import { v } from 'convex/values'
import { isDeepStrictEqual } from 'node:util'

import type * as Fixture from './toolTurnsFixture'

type FixtureApi = ApiFromModules<{
  toolTurnsFixture: typeof Fixture
}>['toolTurnsFixture']
const appendResult = makeFunctionReference<
  'mutation',
  FunctionArgs<FixtureApi['_appendResult']>
>('toolTurnsFixture:_appendResult')

export const _measure = internalAction({
  args: {
    streamId: v.id('streams'),
    generation: v.number(),
    toolSteps: v.number(),
    verify: v.optional(v.boolean()),
  },
  handler: async (ctx, { toolSteps, verify, ...execution }) => {
    const { prepare } = await import('@cv/convex/actions/stream/engineSetup')
    const snapshot: ProviderHistorySnapshot = {}
    const samples = []
    for (let step = 0; step <= toolSteps; step++) {
      if (step > 0) {
        await ctx.runMutation(appendResult, {
          streamId: execution.streamId,
          index: step,
        })
      }
      const started = performance.now()
      const setup = await prepare(ctx, execution, snapshot)
      const elapsedMs = performance.now() - started
      if (!setup) throw new Error('Provider setup did not complete')
      if (verify) {
        const fresh = await prepare(ctx, execution)
        if (!isDeepStrictEqual(setup.messages, fresh?.messages)) {
          throw new Error(`Provider history mismatch at step ${step + 1}`)
        }
      }
      samples.push({ elapsedMs, ...inspectMessages(setup.messages) })
    }
    return samples
  },
})

type Prepared = NonNullable<Awaited<ReturnType<typeof prepareProvider>>>

function inspectMessages(messages: Prepared['messages']) {
  const toolParts = messages.flatMap(({ content }) =>
    typeof content === 'string'
      ? []
      : content.flatMap((part) =>
          part.type === 'tool-result' || part.type === 'tool-call'
            ? [`${part.type}:${part.toolCallId}`]
            : [],
        ),
  )
  const serialized = JSON.stringify(messages)
  return {
    toolParts,
    includesInput: serialized.includes('Current benchmark turn input.'),
    includesOldest: serialized.includes('History message 0.'),
  }
}
