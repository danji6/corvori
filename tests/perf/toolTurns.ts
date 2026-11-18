import {
  type ApiFromModules,
  type FunctionArgs,
  type FunctionReturnType,
  makeFunctionReference,
} from 'convex/server'
import { strict as assert } from 'node:assert'

import { adminClient, fixtureClient } from './clients'
import { type Deployment, withDeployment } from './deployment'
import { createReport, functionLogs, percentiles, queryWork } from './report'
import type * as Action from './toolTurnsAction'
import type * as Fixture from './toolTurnsFixture'

const WARMUPS = 2
const ROUNDS = 10
const HISTORY_QUERY = 'streams:_getProviderHistorySnapshot'
const CONTEXT_QUERY = 'streams:_getContext'
type BenchmarkApi = ApiFromModules<{
  toolTurnsAction: typeof Action
  toolTurnsFixture: typeof Fixture
}>
const measureAction = makeFunctionReference<
  'action',
  FunctionArgs<BenchmarkApi['toolTurnsAction']['_measure']>,
  FunctionReturnType<BenchmarkApi['toolTurnsAction']['_measure']>
>('toolTurnsAction:_measure')

type Scenario = { historyMessages: number; toolSteps: number }
type TurnSample = Awaited<ReturnType<typeof measureTurn>>
type Measure = ReturnType<typeof setup>

function setup(deployment: Deployment) {
  return {
    client: adminClient(deployment),
    mutate: fixtureClient<typeof Fixture>(deployment, 'toolTurnsFixture'),
    logs: functionLogs(deployment),
  }
}

async function measureTurn(
  { client, mutate, logs }: Measure,
  owner: FunctionReturnType<BenchmarkApi['toolTurnsFixture']['_owner']>,
  { historyMessages, toolSteps }: Scenario,
) {
  const execution = await mutate('_turn', { ...owner, historyMessages })
  const results = await client.action(measureAction, {
    ...execution,
    toolSteps,
  })
  assert.equal(results.length, toolSteps + 1, 'Missing provider setup samples')
  const entries = await logs.since()
  const reads = entries.filter(({ identifier }) => identifier === HISTORY_QUERY)
  assert.equal(
    reads.length,
    results.length,
    'Missing or extra history query logs',
  )
  const contexts = entries.filter(
    ({ identifier }) => identifier === CONTEXT_QUERY,
  )
  assert.equal(
    contexts.length,
    results.length,
    'Unexpected context query count',
  )
  const expectedParts: string[] = []

  return results.map((result, step) => {
    if (step > 0) {
      expectedParts.push(
        `tool-call:perf-call-${step}`,
        `tool-result:perf-call-${step}`,
      )
    }
    assert.ok(result.includesInput, 'Provider context lost the current input')
    assert.equal(
      result.includesOldest,
      historyMessages === 16,
      'Unexpected history trimming',
    )
    assert.deepEqual([...result.toolParts].sort(), [...expectedParts].sort())
    return {
      elapsedMs: result.elapsedMs,
      history: queryWork([reads[step]], HISTORY_QUERY),
      context: queryWork([contexts[step]], CONTEXT_QUERY),
    }
  })
}

type Work = { documents: number; bytes: number }
type Sample = { elapsedMs: number; history: Work; context: Work }

function summarizeWork(samples: Work[], metric: keyof Work) {
  return {
    mean:
      samples.reduce((total, sample) => total + sample[metric], 0) /
      samples.length,
    max: Math.max(...samples.map((sample) => sample[metric])),
  }
}

function summarizeSamples(samples: Sample[]) {
  return {
    samples: samples.length,
    setup: percentiles(samples.map(({ elapsedMs }) => elapsedMs)),
    historyDocuments: summarizeWork(
      samples.map(({ history }) => history),
      'documents',
    ),
    historyBytes: summarizeWork(
      samples.map(({ history }) => history),
      'bytes',
    ),
    contextDocuments: summarizeWork(
      samples.map(({ context }) => context),
      'documents',
    ),
    contextBytes: summarizeWork(
      samples.map(({ context }) => context),
      'bytes',
    ),
  }
}

function sumWork(samples: Work[]): Work {
  return {
    documents: samples.reduce((total, sample) => total + sample.documents, 0),
    bytes: samples.reduce((total, sample) => total + sample.bytes, 0),
  }
}

function summarizeTurns(rounds: TurnSample[]) {
  return summarizeSamples(
    rounds.map((steps) => ({
      elapsedMs: steps.reduce((total, step) => total + step.elapsedMs, 0),
      history: sumWork(steps.map(({ history }) => history)),
      context: sumWork(steps.map(({ context }) => context)),
    })),
  )
}

export async function runToolTurns() {
  const report = createReport('tool-turns', {
    warmups: WARMUPS,
    rounds: ROUNDS,
  })
  try {
    await withDeployment(async (deployment) => {
      const measure = setup(deployment)
      const owner = await measure.mutate('_owner', {})
      let smallHistoryFollowUpReads: number[] | undefined
      for (const historyMessages of [16, 128, 512]) {
        for (const toolSteps of [0, 5]) {
          const scenario = { historyMessages, toolSteps }
          const verification = await measure.mutate('_turn', {
            ...owner,
            historyMessages,
          })
          await measure.client.action(measureAction, {
            ...verification,
            toolSteps,
            verify: true,
          })
          await measure.logs.since()
          const samples: TurnSample[] = []
          for (let round = -WARMUPS; round < ROUNDS; round++) {
            const turn = await measureTurn(measure, owner, scenario)
            if (round >= 0) samples.push(turn)
          }
          const total = summarizeTurns(samples)
          const steps = samples[0].map((_, step) => ({
            step: step + 1,
            ...summarizeSamples(samples.map((turn) => turn[step])),
          }))
          report.record({ ...scenario, total, steps })
          if (!toolSteps) continue
          const followUpReads = steps
            .slice(1)
            .map(({ historyDocuments }) => historyDocuments.max)
          smallHistoryFollowUpReads ??= followUpReads
          assert.deepEqual(
            followUpReads,
            smallHistoryFollowUpReads,
            'Follow-up history reads grew with transcript length',
          )
          if (historyMessages === 512) {
            const fullReads = steps[0].historyBytes.mean * steps.length
            assert.ok(
              total.historyBytes.mean <= fullReads * 0.25,
              'Expected at least 75% fewer history bytes than a full read on every step',
            )
          }
        }
      }
    }, 'toolTurnsFixture')
    await report.writeReport()
  } catch (error) {
    await report.writeReport(error)
    throw error
  }
}
