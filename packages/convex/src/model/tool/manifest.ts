import {
  ASK_TOOL_NAME,
  CALL_MCP_TOOL_NAME,
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  LIST_SKILLS_TOOL_NAME,
  MCP_PROTOCOL_TOOL_NAME,
  READ_MCP_OUTPUT_TOOL_NAME,
  READ_SKILL_TOOL_NAME,
  SEARCH_MCP_TOOLS_NAME,
  SHELL_TOOL_NAME,
  TASK_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  YIELD_TOOL_NAME,
} from '@cv/core/const'
import {
  TOOL_CAPABILITIES,
  isReservedToolName,
} from '@cv/core/tool-capabilities'
import { mcpToolDescription, mcpToolName } from '@cv/core/types'
import { MCP_MANIFEST_VERSION } from '@cv/core/types/mcp-catalog'
import type { Infer } from 'convex/values'

import type { Doc } from '../../_generated/dataModel'
import { type Role, minRole } from '../../lib/roles'
import type {
  toolDefinitionValidator,
  toolkitContextValidator,
} from '../../validators/tools'
import type { SpawnableAgent } from '../agent/subagents'
import { isMcpServerSelected, isMcpToolSelected } from '../mcp/toolPolicy'
import type { Session } from '../session/types'
import {
  type ToolResources,
  enabledMcpServers,
  normalizeWebSearchInstances,
} from './settings'

/**
 * The cached shape of a session's tool set the provider sees.
 * Deliberately excludes anything behavioral.
 */
export type ToolDefinition = Infer<typeof toolDefinitionValidator>
export type ToolkitContext = Infer<typeof toolkitContextValidator>

export type ToolManifest = {
  toolkits?: ToolkitContext[]
  contextId?: string
  definitions?: ToolDefinition[]
  version?: number
  /** Exact tool names, in the order they are sent. */
  names: string[]
  /** Personal-folder guidance captured with file and shell descriptions. */
  hasAgentHome?: boolean
  /** Agent roster baked into the task tool description. */
  taskRoster?: string
  /** Shell used to execute commands. Absent only on sidecar errors. */
  shell?: string
  /** External MCP metadata, keyed by name. */
  mcp?: McpManifestEntry[]
}

export type McpManifestEntry = {
  /** Tool name (label slug + tool name). */
  name: string
  /** Settings row id, used to look the server up at call time. */
  serverId: string
  /** Tool name as the external server knows it. */
  toolName: string
  /** Tool description. */
  description?: string
  /** Serialized JSON Schema; Convex rejects `$`-prefixed object keys. */
  inputSchema?: string
  /** Full output schema used internally for validation, never sent to the provider. */
  definitionRef?: string
  diagnostic?: string
}

export type ToolAvailability = {
  skills?: boolean
  storedMcpOutput?: boolean
}

export type ManifestInput = {
  toolkitContext?: ToolkitContext[]
  agent: Pick<Doc<'agents'>, 'tools' | 'shell'>
  invoker: Pick<Doc<'users'>, 'role'>
  session: Pick<Session, 'workspace' | 'parent'>
  resources: ToolResources
  spawnableAgents: SpawnableAgent[]
  /** The owner's settings, for the fields the agent may override. */
  settings?: Pick<Doc<'settings'>, 'shell'> | null
  /** What an unconfigured shell resolves to on the sidecar's host. */
  defaultShell?: string
  availability?: ToolAvailability
}

function resolveShell(data: ManifestInput): string | undefined {
  const shell = data.agent.shell || data.settings?.shell || data.defaultShell
  return shell || undefined
}

/** Builds the roster block appended to the task tool description. */
export function buildTaskRoster(spawnable: SpawnableAgent[]): string {
  return spawnable
    .map(
      (agent) =>
        `- ${agent.name}${agent.description ? `: ${agent.description}` : ''}`,
    )
    .join('\n')
}

/**
 * Resolves current tool eligibility. The initial provider shape is captured separately.
 */
export function resolveToolManifest(data: ManifestInput): ToolManifest {
  const admin = minRole(data.invoker.role as Role | undefined, 'admin')
  const selected = new Set(data.agent.tools ?? [])

  const servers = enabledMcpServers(data.resources.mcpServers).filter(
    (server) => server.transport !== 'stdio' || admin,
  )
  const authorized = servers.filter((server) =>
    isMcpServerSelected(data.agent, server),
  )
  const canCall = authorized.some(
    (server) =>
      !server.catalogId ||
      server.tools?.some((tool) => isMcpToolSelected(data.agent, server, tool)),
  )

  const eligible = (name: string) =>
    builtinEligible(name, data, authorized.length > 0, canCall)

  const names: string[] = []
  for (const capability of TOOL_CAPABILITIES) {
    if (!selected.has(capability.name)) continue
    if ('requiresAdmin' in capability && !admin) continue
    names.push(...capability.tools.filter(eligible))
  }

  const mcp = directMcpEntries(data, servers)
  names.push(...mcp.map((entry) => entry.name))
  const roster = names.includes(TASK_TOOL_NAME)
    ? buildTaskRoster(data.spawnableAgents)
    : undefined
  const shell = names.includes(SHELL_TOOL_NAME) ? resolveShell(data) : undefined

  return {
    version: MCP_MANIFEST_VERSION,
    ...(data.toolkitContext?.length && {
      toolkits: data.toolkitContext,
    }),
    names,
    ...(data.session.workspace?.agentHome && { hasAgentHome: true }),
    ...(roster && { taskRoster: roster }),
    ...(shell && { shell }),
    ...(mcp.length && { mcp }),
  }
}

/** Applies resource requirements after expanding an explicitly selected capability. */
function builtinEligible(
  name: string,
  data: ManifestInput,
  hasServer: boolean,
  canCall: boolean,
) {
  const subagent = !!data.session.parent
  switch (name) {
    case ASK_TOOL_NAME:
    case YIELD_TOOL_NAME:
    case ENTER_PLAN_MODE_TOOL_NAME:
    case EXIT_PLAN_MODE_TOOL_NAME:
      return !subagent
    case TASK_TOOL_NAME:
      return !subagent && data.spawnableAgents.length > 0
    case WEB_SEARCH_TOOL_NAME:
      return (
        normalizeWebSearchInstances(data.resources.settings?.webSearchInstances)
          .length > 0
      )
    case SEARCH_MCP_TOOLS_NAME:
    case MCP_PROTOCOL_TOOL_NAME:
      return hasServer
    case CALL_MCP_TOOL_NAME:
      return canCall
    case READ_MCP_OUTPUT_TOOL_NAME:
      return hasServer || !!data.availability?.storedMcpOutput
    case LIST_SKILLS_TOOL_NAME:
    case READ_SKILL_TOOL_NAME:
      return !!data.availability?.skills
    default:
      return true
  }
}

/** Captures only individually selected standalone tools without shadowing built-ins. */
function directMcpEntries(
  data: ManifestInput,
  servers: ReturnType<typeof enabledMcpServers>,
) {
  const selected = new Set(data.agent.tools ?? [])
  const seen = new Set<string>()
  const entries: McpManifestEntry[] = []
  for (const server of servers) {
    if (server.toolkitId) continue
    for (const meta of server.tools ?? []) {
      const name = mcpToolName(server, meta)
      if (isReservedToolName(name) || seen.has(name)) continue
      seen.add(name)
      if (!selected.has(name)) continue
      if (meta.enabled === false || meta.diagnostic) continue
      entries.push({
        name,
        serverId: server.id,
        toolName: meta.name,
        description: meta.definitionRef
          ? meta.descriptionOverride
          : mcpToolDescription(meta),
        inputSchema: meta.inputSchema,
        definitionRef: meta.definitionRef,
        diagnostic: meta.diagnostic,
      })
    }
  }
  return entries
}

/** Compares callable contracts, including description changes that need new guidance. */
export function sameDefinition(
  previous: ToolDefinition | undefined,
  next: ToolDefinition | undefined,
): boolean {
  return (
    !!previous &&
    !!next &&
    previous.definitionRef === next.definitionRef &&
    previous.description === next.description &&
    previous.inputSchema === next.inputSchema
  )
}
