import type { McpServer } from '@cv/core/types/mcp'
import type { ModelProviderConfig } from '@cv/core/types/providers'
import type { ToolApprovals } from '@cv/core/types/tools'
import type { Infer } from 'convex/values'

import type { Doc } from '../../_generated/dataModel'
import type { StreamState } from '../../validators/streams'
import type { toolkitContextValidator } from '../../validators/tools'
import type { SpawnableAgent } from '../agent/subagents'
import type { PromptSets } from '../prompts'
import type { Session } from '../session/types'
import type { AgentWithHome } from '../skills/homes'

export type RunningStream = Omit<Doc<'streams'>, 'state'> & {
  state: Extract<StreamState, { phase: 'streaming' }>
}

export type StreamContext = {
  stream: RunningStream
  session: Session
  environment: Record<string, unknown>
  toolApprovals?: ToolApprovals
  agent: AgentWithHome
  hasStoredMcpOutput?: boolean
  toolkitContext?: Infer<typeof toolkitContextValidator>[]
  toolkitSkillRevision?: string
  invoker: Doc<'users'>
  invokerSettings: Doc<'settings'> | null
  owner: Doc<'users'>
  ownerSettings: Doc<'settings'> | null
  output: Doc<'messages'> & { parts: unknown[] }
  settings: Doc<'settings'> | null
  /** Every prompt set the agent resolves to, from the `prompts` table. */
  prompts: PromptSets
  /** Enabled and disabled servers alike, joined with their credentials. */
  mcpServers: McpServer[]
  /** Providers joined with their credentials, for building the model client. */
  modelProviders: ModelProviderConfig[]
  plan: Doc<'plans'> | null
  sessionCache: Doc<'sessionCache'> | null
  spawnableAgents: SpawnableAgent[]
}
