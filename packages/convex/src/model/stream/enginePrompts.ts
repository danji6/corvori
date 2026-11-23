'use node'

import { hasInterpolation } from '@cv/core/interpreter/parse'

import { internal } from '../../_generated/api'
import type { Id } from '../../_generated/dataModel'
import { minRole } from '../../lib/roles'
import type { PromptItem } from '../prompt/prompts'
import { runPromptEvaluation } from '../promptEvaluation/runner'
import {
  type PreparedStepTools,
  type StepContext,
  prepareStepChanges,
} from './engineTools'
import { buildOperationMessages, createOperationPlan } from './operations'

type OperationPlan = ReturnType<typeof createOperationPlan>

type EvaluationOptions = {
  deadline: number
  toolNames: string[]
  model?: { id: string; label?: string }
}

export async function prepareStepPrompts(
  step: StepContext,
  tools: PreparedStepTools,
  modelLabel?: string,
) {
  const { data, windowDeadline } = step
  const plan = createOperationPlan(data, tools.manifest)
  const capturesScriptChanges = needsScriptCapture(step, tools, plan)
  if (capturesScriptChanges && !(await prepareStepChanges(step))) return null

  const options: EvaluationOptions = {
    toolNames: tools.names,
    model: data.agent.modelOverride
      ? { id: data.agent.modelOverride.modelId, label: modelLabel }
      : undefined,
    deadline: windowDeadline ?? Date.now() + 60_000,
  }
  const snapshotId = await reservePromptSnapshot(step, plan.evalItems)
  if (!snapshotId) return null

  const items = await prepareEvaluation(step, snapshotId, options)
  if (!items) return null

  const patch = tools.builtTools && plan.snapshotPatch()
  if (patch && !(await savePromptSnapshot(step, snapshotId, patch))) return null

  return { items, operationPrompts: plan.operationPrompts, options }
}

function needsScriptCapture(
  { data }: StepContext,
  { capturesFiles }: PreparedStepTools,
  { evalItems, operationPrompts }: OperationPlan,
) {
  if (capturesFiles) return false
  if (!minRole(data.invoker.role, 'admin')) return false
  if (!minRole(data.owner.role, 'admin')) return false

  const authored = [
    ...(data.sessionCache?.promptEvaluationId ? [] : evalItems),
    ...operationPrompts,
  ]
  return authored.some(
    (item) =>
      'content' in item && item.enabled && hasInterpolation(item.content),
  )
}

async function reservePromptSnapshot(
  { ctx, execution, data }: StepContext,
  items: PromptItem[],
) {
  const id =
    data.sessionCache?.promptEvaluationId ??
    (await ctx.runMutation(internal.promptEvaluations._reserve, {
      ...execution,
      kind: 'snapshot',
      items,
      cacheId: data.sessionCache?._id,
    }))
  if (!id) await ctx.runMutation(internal.streams._handoff, execution)
  return id
}

async function savePromptSnapshot(
  { ctx, execution, data }: StepContext,
  id: Id<'promptEvaluations'>,
  patch: NonNullable<ReturnType<OperationPlan['snapshotPatch']>>,
) {
  const saved = await ctx.runMutation(internal.streams._saveSessionCache, {
    ...execution,
    sessionId: data.stream.sessionId,
    agentId: data.stream.agentId,
    ...patch,
    promptEvaluationId: id,
    filesystemAccess: minRole(data.invoker.role, 'admin'),
  })
  if (!saved) await ctx.runMutation(internal.streams._handoff, execution)
  return saved
}

type PreparedPrompts = NonNullable<
  Awaited<ReturnType<typeof prepareStepPrompts>>
>

export async function prepareOperationMessages(
  step: StepContext,
  { operationPrompts, options }: PreparedPrompts,
) {
  if (!operationPrompts.length) return undefined

  const { ctx, execution, data } = step
  const id = await ctx.runMutation(internal.promptEvaluations._reserve, {
    ...execution,
    kind: 'operation',
    items: operationPrompts,
  })
  if (!id) return null

  const items = await prepareEvaluation(step, id, { ...options, toolNames: [] })
  if (!items) return null
  return buildOperationMessages(items, data.stream.command)
}

async function prepareEvaluation(
  { ctx, execution }: StepContext,
  id: Id<'promptEvaluations'>,
  options: EvaluationOptions,
): Promise<PromptItem[] | null> {
  const api = internal.promptEvaluations

  const active = () => ctx.runQuery(internal.streams._isActive, execution)

  const frozen = await ctx.runQuery(api._result, { id })
  if (frozen) return (await active()) ? frozen : null

  const heartbeat = () =>
    ctx.runMutation(internal.streams._heartbeat, execution)
  const result = await runPromptEvaluation(ctx, id, {
    ...options,
    active,
    heartbeat,
  })
  if (result === 'waiting') {
    await ctx.runMutation(internal.streams._handoff, execution)
    return null
  }

  if (!(await active())) return null

  const state = await ctx.runQuery(api._get, { id })
  if (!state || state.evaluation.state === 'cancelled') {
    await ctx.runMutation(internal.streams._handoff, execution)
    return null
  }
  if (state.evaluation.state === 'failed')
    throw new Error(state.evaluation.error)

  return ctx.runQuery(api._result, { id })
}
