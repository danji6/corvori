import {
  ASK_TOOL_NAME,
  ATTACH_FILE_TOOL_NAME,
  CALL_MCP_TOOL_NAME,
  CALL_TOOL_NAME,
  COPY_ATTACHMENT_TOOL_NAME,
  DISPATCH_ERROR_TOOL,
  EDIT_FILE_TOOL_NAME,
  EDIT_PLAN_TOOL_NAME,
  EDIT_TODO_TOOL_NAME,
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  GET_TOOL_NAME,
  KILL_SHELL_TOOL_NAME,
  LIST_SKILLS_TOOL_NAME,
  MCP_PROTOCOL_TOOL_NAME,
  READ_ATTACHMENT_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  READ_MCP_OUTPUT_TOOL_NAME,
  READ_SKILL_TOOL_NAME,
  SEARCH_MCP_TOOLS_NAME,
  SHELL_OUTPUT_TOOL_NAME,
  SHELL_TOOL_NAME,
  TASK_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
  WRITE_PLAN_TOOL_NAME,
  WRITE_TODO_TOOL_NAME,
  YIELD_TOOL_NAME,
} from './const'

/** One opt-in setting for each coherent built-in workflow. */
export const TOOL_CAPABILITIES = [
  {
    name: ASK_TOOL_NAME,
    label: 'Ask questions',
    description: 'Ask you for decisions when needed.',
    category: 'general',
    tools: [ASK_TOOL_NAME],
  },
  {
    name: READ_ATTACHMENT_TOOL_NAME,
    label: 'Read attachments',
    description: 'Read attached files.',
    category: 'general',
    tools: [READ_ATTACHMENT_TOOL_NAME],
  },
  {
    name: 'process_attachments',
    label: 'Process attachments',
    description: 'Copy and present attachments.',
    category: 'general',
    tools: [COPY_ATTACHMENT_TOOL_NAME, ATTACH_FILE_TOOL_NAME],
  },
  {
    name: TASK_TOOL_NAME,
    label: 'Delegate tasks',
    description: 'Delegate work to subagents.',
    category: 'collaboration',
    tools: [TASK_TOOL_NAME],
  },
  {
    name: YIELD_TOOL_NAME,
    label: 'Hand off turns',
    description: 'Let another agent respond next.',
    category: 'collaboration',
    tools: [YIELD_TOOL_NAME],
  },
  {
    name: WEB_FETCH_TOOL_NAME,
    label: 'Web fetch',
    description: 'Fetch a web page as readable text.',
    category: 'web',
    tools: [WEB_FETCH_TOOL_NAME],
  },
  {
    name: WEB_SEARCH_TOOL_NAME,
    label: 'Web search',
    description: 'Search through your configured search engines.',
    category: 'web',
    tools: [WEB_SEARCH_TOOL_NAME],
  },
  {
    name: READ_FILE_TOOL_NAME,
    label: 'Read files',
    description: 'Read files in source directories and agent folders.',
    category: 'workspace',
    tools: [READ_FILE_TOOL_NAME],
    requiresAdmin: true,
  },
  {
    name: 'edit_files',
    label: 'Edit files',
    description: 'Create, replace, and edit files.',
    category: 'workspace',
    tools: [WRITE_FILE_TOOL_NAME, EDIT_FILE_TOOL_NAME],
    requiresAdmin: true,
  },
  {
    name: SHELL_TOOL_NAME,
    label: 'Shell',
    description: 'Run shell commands on the host machine.',
    category: 'workspace',
    tools: [SHELL_TOOL_NAME, SHELL_OUTPUT_TOOL_NAME, KILL_SHELL_TOOL_NAME],
    requiresAdmin: true,
  },
  {
    name: 'plan',
    label: 'Planning',
    description: 'Write plans and enter or leave plan mode.',
    category: 'planning',
    tools: [
      WRITE_PLAN_TOOL_NAME,
      EDIT_PLAN_TOOL_NAME,
      ENTER_PLAN_MODE_TOOL_NAME,
      EXIT_PLAN_MODE_TOOL_NAME,
    ],
    requiresAdmin: true,
  },
  {
    name: 'todo',
    label: 'Todo list',
    description: 'Create and update a task list.',
    category: 'planning',
    tools: [WRITE_TODO_TOOL_NAME, EDIT_TODO_TOOL_NAME],
  },
  {
    name: 'mcp_access',
    label: 'MCP access',
    description: 'Discover and call MCP servers.',
    category: 'mcp-skills',
    tools: [
      SEARCH_MCP_TOOLS_NAME,
      CALL_MCP_TOOL_NAME,
      MCP_PROTOCOL_TOOL_NAME,
      READ_MCP_OUTPUT_TOOL_NAME,
    ],
  },
  {
    name: 'skills',
    label: 'Skills',
    description: 'Make use of available skills.',
    category: 'mcp-skills',
    tools: [LIST_SKILLS_TOOL_NAME, READ_SKILL_TOOL_NAME],
    requiresAdmin: true,
  },
] as const

export type ToolCapability = (typeof TOOL_CAPABILITIES)[number]
export type BuiltinToolName = ToolCapability['tools'][number]

export const BUILTIN_TOOL_NAMES: readonly string[] = TOOL_CAPABILITIES.flatMap(
  (capability) => [...capability.tools],
)

const capabilityNames = new Set<string>(
  TOOL_CAPABILITIES.map((row) => row.name),
)
const reserved = new Set<string>([
  ...BUILTIN_TOOL_NAMES,
  ...capabilityNames,
  GET_TOOL_NAME,
  CALL_TOOL_NAME,
  DISPATCH_ERROR_TOOL,
])

/** Protects both callable names and selection keys from external aliases. */
export function isReservedToolName(name: string) {
  return reserved.has(name)
}

/** Expands saved capability choices without granting missing prerequisites. */
export function selectedBuiltinTools(
  selection: readonly string[] = [],
): string[] {
  const selected = new Set(selection)
  return TOOL_CAPABILITIES.filter((row) => selected.has(row.name)).flatMap(
    (row) => [...row.tools],
  )
}

export const FILESYSTEM_TOOL_NAMES = [
  READ_FILE_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
  EDIT_FILE_TOOL_NAME,
  SHELL_TOOL_NAME,
  SHELL_OUTPUT_TOOL_NAME,
  KILL_SHELL_TOOL_NAME,
] as const

export function hasFilesystemTools(names: readonly string[]) {
  return FILESYSTEM_TOOL_NAMES.some((name) => names.includes(name))
}

/** Drops retired member selections while preserving independent external choices. */
export function normalizeToolSelection(names: readonly string[] = []) {
  return [...new Set(names)].filter(
    (name) => !isReservedToolName(name) || capabilityNames.has(name),
  )
}

/** Changes only the requested choices, retaining external selections absent from discovery. */
export function toggleToolSelection(
  selection: readonly string[],
  targets: readonly string[],
  available: readonly { name: string }[],
) {
  const selected = new Set(normalizeToolSelection(selection))
  const allOn = targets.every((name) => selected.has(name))
  for (const name of targets) {
    if (allOn) selected.delete(name)
    else selected.add(name)
  }
  const ordered = available
    .filter((row) => selected.has(row.name))
    .map((row) => row.name)
  const known = new Set(ordered)
  return [...ordered, ...[...selected].filter((name) => !known.has(name))]
}

export const SESSION_FILE_TOOL_NAMES = [
  COPY_ATTACHMENT_TOOL_NAME,
  ATTACH_FILE_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
  EDIT_FILE_TOOL_NAME,
  SHELL_TOOL_NAME,
] as const

export function hasSessionFileTools(names: readonly string[]) {
  return SESSION_FILE_TOOL_NAMES.some((name) => names.includes(name))
}
