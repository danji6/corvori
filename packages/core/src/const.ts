/** Internal app identifier, never shown to users. */
export const APP_ID = 'corvori'
/** App name shown to the users. */
export const APP_NAME = 'Corvori'

export const FALLBACK_DISPLAY_NAME = 'Anonymous'

// Byte budgets for message pagination and streaming splits. Sizes are
// serialized UTF-16 code units (see `serializedSize`), not true bytes.
/** Content budget for a single message window fetch. */
export const MESSAGE_PAGE_BUDGET_BYTES = 128 * 1024
/** Content budget for the full retained message window. */
export const MESSAGE_WINDOW_BUDGET_BYTES = 512 * 1024
/** A streaming agent message splits once its parts exceed this. */
export const MESSAGE_SPLIT_BUDGET_BYTES = 64 * 1024
/** Row count safety cap for a single message window fetch. */
export const MESSAGE_PAGE_MAX_ROWS = 40
/** Row count safety cap for the full retained message window. */
export const MESSAGE_WINDOW_MAX_ROWS = 160

/** Target spacing for ordinary streaming patches and the reveal animation. */
export const STREAM_PATCH_INTERVAL_MS = 200

/** Steps without a todo write/edit before unresolved todos trigger a nudge. */
export const TODO_NUDGE_INTERVAL_STEPS = 20

/** Single agent settings toggle covering both todo tools. */
export const TODO_TOOL_TOGGLE = 'todo'

/** Single agent settings toggle covering every plan tool. */
export const PLAN_TOOL_TOGGLE = 'plan'

/** Built-in client-executed tool used to pause for human decisions. */
export const ASK_TOOL_NAME = 'ask'

/** Built-in client-executed tool that hands the next turn to another agent. */
export const YIELD_TOOL_NAME = 'yield'

/** Default time a yield request waits before it is accepted on its own. */
export const DEFAULT_YIELD_CONFIRM_MS = 5000

/** Built-in tool for reading attachments. */
export const READ_ATTACHMENT_TOOL_NAME = 'read_attachment'

export const TASK_TOOL_NAME = 'task'
export const COPY_ATTACHMENT_TOOL_NAME = 'copy_attachment'
export const ATTACH_FILE_TOOL_NAME = 'attach_file'
export const READ_FILE_TOOL_NAME = 'read_file'
export const WRITE_FILE_TOOL_NAME = 'write_file'
export const EDIT_FILE_TOOL_NAME = 'edit_file'
export const CHECK_PATHS_TOOL_NAME = 'check_paths'
export const SHELL_TOOL_NAME = 'shell'
export const SHELL_OUTPUT_TOOL_NAME = 'shell_output'
export const KILL_SHELL_TOOL_NAME = 'kill_shell'
export const WRITE_PLAN_TOOL_NAME = 'write_plan'
export const EDIT_PLAN_TOOL_NAME = 'edit_plan'
export const ENTER_PLAN_MODE_TOOL_NAME = 'enter_plan_mode'
export const EXIT_PLAN_MODE_TOOL_NAME = 'exit_plan_mode'
export const WRITE_TODO_TOOL_NAME = 'write_todo'
export const EDIT_TODO_TOOL_NAME = 'edit_todo'
export const WEB_FETCH_TOOL_NAME = 'web_fetch'
export const WEB_SEARCH_TOOL_NAME = 'web_search'
export const LIST_SKILLS_TOOL_NAME = 'list_skills'
export const READ_SKILL_TOOL_NAME = 'read_skill'
export const SEARCH_MCP_TOOLS_NAME = 'search_mcp_tools'
export const CALL_MCP_TOOL_NAME = 'call_mcp_tool'
export const MCP_PROTOCOL_TOOL_NAME = 'mcp_protocol'
export const READ_MCP_OUTPUT_TOOL_NAME = 'read_mcp_output'
export const GET_TOOL_NAME = 'get_tool'
export const CALL_TOOL_NAME = 'call_tool'
export const DISPATCH_ERROR_TOOL = '__cv_tool_error'

export const ASK_TOOL_PART_TYPE = `tool-${ASK_TOOL_NAME}` as const
export const TASK_TOOL_PART_TYPE = `tool-${TASK_TOOL_NAME}` as const
export const SHELL_TOOL_PART_TYPE = `tool-${SHELL_TOOL_NAME}` as const
export const SHELL_OUTPUT_TOOL_PART_TYPE = `tool-${SHELL_OUTPUT_TOOL_NAME}` as const // prettier-ignore
export const READ_ATTACHMENT_TOOL_PART_TYPE = `tool-${READ_ATTACHMENT_TOOL_NAME}` as const // prettier-ignore
export const READ_FILE_TOOL_PART_TYPE = `tool-${READ_FILE_TOOL_NAME}` as const
export const WRITE_FILE_TOOL_PART_TYPE = `tool-${WRITE_FILE_TOOL_NAME}` as const
export const EDIT_FILE_TOOL_PART_TYPE = `tool-${EDIT_FILE_TOOL_NAME}` as const
export const LIST_SKILLS_TOOL_PART_TYPE = `tool-${LIST_SKILLS_TOOL_NAME}` as const // prettier-ignore

/** Large plain text pastes become attachments at this UTF-8 byte size. */
export const LARGE_PASTE_BYTES = 16 * 1024

/** Default and maximum byte windows returned by read_attachment. */
export const ATTACHMENT_READ_MAX_BYTES = 8 * 1024
export const ATTACHMENT_READ_DEFAULT_BYTES = ATTACHMENT_READ_MAX_BYTES

/** Compact edit_todo statuses mapped to their stored counterparts. */
export const TODO_EDIT_STATUSES = {
  todo: 'pending',
  doing: 'in_progress',
  done: 'completed',
} as const

export type TodoEditStatus = keyof typeof TODO_EDIT_STATUSES
