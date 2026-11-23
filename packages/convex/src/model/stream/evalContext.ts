'use node'

import type { EvalContext } from '@cv/core/interpreter/types'
import { parseModelReference } from '@cv/core/model-reference'
import { toDisplayName, toOptionalName } from '@cv/core/utils/names'

import type { Doc } from '../../_generated/dataModel'
import { minRole } from '../../lib/roles'
import type { Session } from '../session/types'

type EvalContextInput = {
  agent: Doc<'agents'> | null
  invoker: Doc<'users'>
  invokerSettings: Doc<'settings'> | null
  ownerSettings: Doc<'settings'> | null
  session: Session
  model?: Pick<NonNullable<Session['model']>, 'id' | 'label'>
  userCount: number
  agentCount: number
  toolNames: string[]
}

/**
 * Builds the interpreter context shared by prompt and message evaluation, so
 * every script resolves against the same variables regardless of where it runs.
 */
export function buildEvalContext({
  agent,
  invoker,
  invokerSettings,
  ownerSettings,
  session,
  model = session.model,
  userCount,
  agentCount,
  toolNames,
}: EvalContextInput): EvalContext {
  const workspace = session.workspace
  const workDirs =
    workspace && !workspace.agentOnly
      ? (workspace.sources?.map((source) => source.path) ?? [workspace.path])
      : undefined

  return {
    assistant: agent?.name,
    user: toOptionalName(invokerSettings?.displayName),
    owner: agent ? toDisplayName(ownerSettings?.displayName) : undefined,
    modelId: model ? parseModelReference(model.id).modelId : undefined,
    modelName:
      model?.label ??
      (model ? parseModelReference(model.id).modelId : undefined),
    tools: toolNames,
    isAdmin: minRole(invoker.role, 'admin'),
    userCount,
    agentCount,
    workDir: workspace && !workspace.agentOnly ? workspace.path : undefined,
    agentDir: agent ? workspace?.agentHome?.path : undefined,
    workDirs,
  }
}
