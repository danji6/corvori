'use node'

import { stableStringify } from '@cv/core/stable-json'
import {
  hasFilesystemTools,
  selectedBuiltinTools,
} from '@cv/core/tool-capabilities'
import { contextEnabled } from '@cv/core/tool-context'

import { internal } from '../../_generated/api'
import type { ActionCtx } from '../../_generated/server'
import { minRole } from '../../lib/roles'
import type { StreamExecutionArgs } from '../../validators/streams'
import { sidecarDefaultShell } from '../sidecar'
import { resolvePersonalWorkspace } from '../skills/runtime'
import {
  type PreparedAvailability,
  prepareToolAvailability,
} from '../tool/availability'
import { capabilitySource } from '../tool/capabilitySource'
import { resolveToolManifest } from '../tool/manifest'
import {
  type SessionTools,
  prepareSessionTools,
  prepareToolReplay,
} from '../tool/sessionTools'
import { prepareToolContext } from './toolContext'
import type { StreamContext } from './types'

export type StepContext = {
  ctx: ActionCtx
  execution: StreamExecutionArgs
  data: StreamContext
  invokesTools: boolean
  selectedTools: string[]
  windowDeadline?: number
}

export async function readStepContext(
  ctx: ActionCtx,
  execution: StreamExecutionArgs,
  windowDeadline?: number,
): Promise<StepContext | null> {
  let data = await ctx.runQuery(internal.streams._getContext, execution)
  if (!data) return null

  const invokesTools = ['invoke', 'retry'].includes(data.stream.command.kind)
  const selectedTools = selectedBuiltinTools(data.agent.tools)
  const observesToolkits =
    (invokesTools || !data.sessionCache) &&
    !!data.toolkitCount &&
    (contextEnabled('mcp', selectedTools) ||
      selectedTools.includes('list_skills')) &&
    minRole(data.invoker.role, 'admin')
  if (observesToolkits) {
    const { observeLinkedToolkits } = await import('../toolkits/actions') // prettier-ignore
    const invalidated = await observeLinkedToolkits(ctx, execution)
    if (invalidated.length) {
      data = await ctx.runQuery(internal.streams._getContext, execution)
      if (!data) return null
    }
  }

  return { ctx, execution, data, invokesTools, selectedTools, windowDeadline }
}

export async function prepareStepTools(step: StepContext) {
  const { ctx, execution, data, invokesTools, selectedTools } = step
  const defaultShell = await prepareWorkspaceAndShell(step)
  const capturesTools =
    invokesTools &&
    selectedTools.some((name) =>
      ['write_file', 'edit_file', 'shell', 'task'].includes(name),
    )
  const capturesFiles = minRole(data.invoker.role, 'admin') && capturesTools
  if (capturesFiles && !(await prepareStepChanges(step))) return null

  const availability = await prepareToolAvailability(ctx, data)
  const current = resolveToolManifest({
    ...data,
    resources: { settings: data.settings, mcpServers: data.mcpServers },
    defaultShell,
    availability,
  })
  const frozen = data.sessionCache?.tools
  const prepared =
    invokesTools || !frozen
      ? await prepareSessionTools(ctx, data, current, step.windowDeadline)
      : undefined
  const manifest = prepared?.frozen ?? frozen!
  const runtime = invokesTools ? prepared : undefined
  const { wireDefinitions, wireCalls } =
    prepared ?? (await prepareToolReplay(ctx, manifest, execution))

  return {
    names: current.names,
    manifest,
    runtime,
    replay: { wireDefinitions, wireCalls },
    availability,
    capturesFiles,
    builtTools: !!prepared,
  }
}

export type PreparedStepTools = NonNullable<
  Awaited<ReturnType<typeof prepareStepTools>>
>

async function prepareWorkspaceAndShell({
  data,
  selectedTools,
  invokesTools,
}: StepContext) {
  const needsPersonalWorkspace =
    hasFilesystemTools(selectedTools) || selectedTools.includes('list_skills')
  if (needsPersonalWorkspace && minRole(data.invoker.role, 'admin')) {
    data.session.workspace = await resolvePersonalWorkspace(
      data.agent,
      data.session.workspace,
    )
  }

  // The shell default is only needed when resolving a manifest.
  const needsShell =
    (invokesTools || !data.sessionCache) &&
    data.agent.tools?.includes('shell') &&
    minRole(data.invoker.role, 'admin')
  if (needsShell) return sidecarDefaultShell()
}

export async function prepareStepChanges({
  ctx,
  execution,
  data,
}: StepContext) {
  const { prepareChanges } = await import('../changes/actions')
  return prepareChanges(ctx, execution, data)
}

export async function publishStepToolContext(
  step: StepContext,
  { availability, names, runtime }: PreparedStepTools,
) {
  const { ctx, execution, data } = step
  if (runtime && !(await publishCapabilities(step, runtime, availability))) {
    return false
  }

  return prepareToolContext(
    ctx,
    execution,
    data,
    names,
    runtime?.frozen.contextId,
    availability,
  )
}

async function publishCapabilities(
  { ctx, execution, data }: StepContext,
  runtime: SessionTools,
  availability: PreparedAvailability,
) {
  const source = await capabilitySource(data)
  const capabilitiesChanged =
    source !== data.sessionCache?.capabilitySource ||
    stableStringify(runtime.current) !==
      stableStringify(data.sessionCache?.effectiveTools) ||
    availability.source !== data.stream.skillCatalogSource
  if (!capabilitiesChanged) return true

  const accepted = await ctx.runMutation(
    internal.streams._prepareCapabilities,
    {
      ...execution,
      source,
      manifest: runtime.current,
      contextId: runtime.frozen.contextId!,
      skillCatalogSource: availability.source,
      skillAvailability: { skills: !!availability.skills },
    },
  )
  if (!accepted) await ctx.runMutation(internal.streams._handoff, execution)
  return accepted
}
