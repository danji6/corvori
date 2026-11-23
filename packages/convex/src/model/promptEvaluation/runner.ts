'use node'

import type { EvaluationResult } from '@cv/core/interpreter/request'

import { internal } from '../../_generated/api'
import type { Id } from '../../_generated/dataModel'
import type { ActionCtx } from '../../_generated/server'
import { isUnevaluatedTextPart } from '../messages'
import { postSidecar } from '../sidecar'
import { resolvePersonalWorkspace } from '../skills/runtime'
import { buildEvalContext } from '../stream/evalContext'
import { resolveToolManifest } from '../tool/manifest'
import { filesystemWorkspace } from '../tool/sessionFilesystem'

const api = internal.promptEvaluations
const route = '/eval/operations'
const pollMs = 250
const requestTimeoutMs = 10_000
const lost =
  'Prompt evaluation was interrupted. The command outcome is unknown.'

type EvaluationId = Id<'promptEvaluations'>

type OperationRef = { id: EvaluationId; bootId: string }

type Options = {
  deadline: number
  toolNames?: string[]
  model?: { id: string; label?: string }
  active?: () => Promise<boolean>
  heartbeat?: () => Promise<unknown>
}

type Status =
  | { state: 'running'; call?: number }
  | { state: 'complete'; result: EvaluationResult }
  | { state: 'failed'; error: string }
  | { state: 'lost' }

export async function runStandaloneEvaluation(
  ctx: ActionCtx,
  id: EvaluationId,
) {
  const state = await ctx.runQuery(api._get, { id })
  if (state?.evaluation.state !== 'pending') return

  // Schedule recovery before watching so an interrupted action has a successor.
  const recovery = await ctx.scheduler.runAfter(
    75_000,
    internal.actions.messages._runPromptEvaluation,
    { id },
  )
  const result = await runPromptEvaluation(ctx, id, {
    deadline: Date.now() + 60_000,
  })
  if (result === 'settled') await ctx.scheduler.cancel(recovery)
}

export async function cancelSidecarEvaluation(ref: OperationRef) {
  await request('cancel', ref).catch(() => {
    // A lost connection stops renewing the sidecar lease.
  })
}

export async function runPromptEvaluation(
  ctx: ActionCtx,
  id: EvaluationId,
  options: Options,
) {
  const data = await readInput(ctx, id)
  if (!data) {
    await ctx.runMutation(api._finish, {
      id,
      error: 'Prompt evaluation target is unavailable',
    })
    return 'settled'
  }

  try {
    const outcome = await watch(ctx, id, data, options)
    if (!outcome) return 'waiting'
    if (outcome.status.state === 'running') return 'settled'
    await publish(ctx, outcome.ref, data, outcome.status)
    return 'settled'
  } catch (error) {
    // A transient transport failure must reconnect using the same reservation.
    if (
      error instanceof TypeError ||
      (error instanceof Error && error.name === 'TimeoutError')
    ) {
      await sleep(pollMs)
      return 'waiting'
    }
    await ctx.runMutation(api._finish, {
      id,
      error: 'Prompt evaluation failed',
    })
    return 'settled'
  }
}

type EvaluationInput = Awaited<ReturnType<typeof readInput>>
function readInput(ctx: ActionCtx, id: EvaluationId) {
  return ctx.runQuery(api._input, { id })
}

async function watch(
  ctx: ActionCtx,
  id: EvaluationId,
  data: NonNullable<EvaluationInput>,
  options: Options,
) {
  if (options.active && !(await options.active())) return

  const initial = await openOperation(ctx, id, data, options)
  if (!initial) return

  const { ref } = initial
  let { status } = initial
  let lastHeartbeat = Date.now()

  while (status.state === 'running') {
    if (Date.now() >= options.deadline) return
    if (options.active && !(await options.active())) return

    if (options.heartbeat && Date.now() - lastHeartbeat >= 60_000) {
      await options.heartbeat()
      lastHeartbeat = Date.now()
    }

    const state = await ctx.runQuery(api._get, { id })
    if (state?.evaluation.state !== 'pending') break

    const grant =
      status.call === undefined
        ? undefined
        : {
            call: status.call,
            allowed: state.allowed,
          }
    if (!grant) await sleep(pollMs)

    status = await request<Status>('status', { ...ref, grant })
  }

  return { ref, status }
}

async function openOperation(
  ctx: ActionCtx,
  id: EvaluationId,
  data: NonNullable<EvaluationInput>,
  options: Options,
) {
  if (data.evaluation.bootId) {
    const ref = { id, bootId: data.evaluation.bootId }
    return { ref, status: await request<Status>('status', ref) }
  }

  const input = await sidecarInput(data, options)
  const { bootId } = await request<{ bootId: string }>('instance', {})
  const pinned = await ctx.runMutation(api._pin, { id, bootId })
  if (!pinned) return

  const ref = { id, bootId: pinned.bootId }
  const status = pinned.start
    ? await request<Status>('start', { ...ref, input })
    : await request<Status>('status', ref)

  return { ref, status }
}

async function sidecarInput(
  data: NonNullable<EvaluationInput>,
  options: Options,
) {
  const { session, agent, evaluation } = data
  const userSend =
    evaluation.target.kind === 'message' &&
    evaluation.target.origin === 'userSend'
  const sessionWorkspace = session.workspace

  if (agent && data.invoker.role === 'admin')
    session.workspace = await resolvePersonalWorkspace(agent, session.workspace)

  const toolNames =
    options.toolNames ??
    (agent
      ? resolveToolManifest({
          ...data,
          agent,
          resources: {
            settings: data.ownerSettings,
            mcpServers: data.mcpServers,
          },
          spawnableAgents: [],
        }).names
      : [])

  const context = buildEvalContext({
    ...data,
    toolNames,
    model: options.model ?? data.model,
  })

  const canReadFiles = context.isAdmin && toolNames.includes('read_file')

  return {
    texts: inputTexts(data),
    kind: evaluation.target.kind === 'message' ? 'message' : 'prompt',
    context,
    environment: data.environment,
    authorizedAgentId: canReadFiles
      ? (session.workspace?.agentHome?.homeId ?? agent?._id)
      : undefined,
    authorizedAgentDir: canReadFiles ? context.agentDir : undefined,
    authorizedWorkDir: canReadFiles ? context.workDir : undefined,
    authorizedWorkDirs: canReadFiles ? context.workDirs : undefined,
    ...shellInput(data, userSend, sessionWorkspace),
  }
}

function shellInput(
  data: NonNullable<EvaluationInput>,
  userSend: boolean,
  sessionWorkspace: NonNullable<EvaluationInput>['session']['workspace'],
) {
  if (!data.allowed) return {}
  if (userSend && !sessionWorkspace) return { shellWorkspaceRequired: true }

  const { session, agent, invokerSettings, ownerSettings } = data
  const workspace = filesystemWorkspace(
    userSend ? { ...session, workspace: sessionWorkspace } : session,
  )

  return {
    shell: {
      sessionId: session.parent?.sessionId ?? session._id,
      workspaceId: workspace.workspaceId,
      workspace,
      shell: userSend
        ? invokerSettings?.shell
        : agent?.shell || ownerSettings?.shell,
    },
  }
}

function inputTexts(data: NonNullable<EvaluationInput>): string[] {
  if (data.evaluation.inputParts) {
    return data.evaluation.inputParts
      .filter(isUnevaluatedTextPart)
      .map((part) => part.text)
  }
  return data.items.flatMap(({ item }) =>
    'content' in item && item.enabled ? [item.content] : [],
  )
}

async function publish(
  ctx: ActionCtx,
  ref: OperationRef,
  data: NonNullable<EvaluationInput>,
  status: Exclude<Status, { state: 'running' }>,
) {
  const { id } = ref
  if (status.state !== 'complete') {
    await ctx.runMutation(api._finish, {
      id,
      error: status.state === 'lost' ? lost : status.error,
    })
  } else {
    const { texts, writes } = status.result
    let index = 0
    const parts = data.evaluation.inputParts?.map((part) =>
      isUnevaluatedTextPart(part)
        ? { ...part, text: texts[index++], evaluationRendered: true }
        : part,
    )
    if (!parts) await stageItems(ctx, id, data.items, texts)
    await ctx.runMutation(api._finish, { id, parts, writes })
  }
  await request('acknowledge', ref).catch(() => {})
}

async function stageItems(
  ctx: ActionCtx,
  id: EvaluationId,
  items: NonNullable<EvaluationInput>['items'],
  texts: string[],
) {
  let index = 0
  for (const { _id, item } of items) {
    if ('content' in item && item.enabled) {
      await ctx.runMutation(api._stage, {
        id,
        itemId: _id,
        content: texts[index++],
      })
    }
  }
}

function request<T>(action: string, input: unknown) {
  return postSidecar<T>(
    `${route}/${action}`,
    input,
    AbortSignal.timeout(requestTimeoutMs),
  )
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}
