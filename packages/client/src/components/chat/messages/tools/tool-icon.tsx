import {
  ASK_TOOL_NAME,
  ATTACH_FILE_TOOL_NAME,
  CALL_MCP_TOOL_NAME,
  COPY_ATTACHMENT_TOOL_NAME,
  EDIT_FILE_TOOL_NAME,
  EDIT_PLAN_TOOL_NAME,
  EDIT_TODO_TOOL_NAME,
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
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
} from '@cv/core/const'
import type { BuiltinToolName } from '@cv/core/tool-capabilities'
import type { LucideIcon } from 'lucide-react'
import {
  BookOpenTextIcon,
  CircleHelpIcon,
  ClipboardListIcon,
  ForwardIcon,
  GlobeIcon,
  LibraryIcon,
  ListTodoIcon,
  NetworkIcon,
  PaperclipIcon,
  PencilIcon,
  PlugIcon,
  SquareTerminalIcon,
} from 'lucide-react'

const TOOL_ICONS: Record<BuiltinToolName, LucideIcon> = {
  [WRITE_FILE_TOOL_NAME]: PencilIcon,
  [EDIT_FILE_TOOL_NAME]: PencilIcon,
  [READ_FILE_TOOL_NAME]: BookOpenTextIcon,
  [READ_ATTACHMENT_TOOL_NAME]: PaperclipIcon,
  [COPY_ATTACHMENT_TOOL_NAME]: PaperclipIcon,
  [ATTACH_FILE_TOOL_NAME]: PaperclipIcon,
  [WEB_SEARCH_TOOL_NAME]: GlobeIcon,
  [WEB_FETCH_TOOL_NAME]: GlobeIcon,
  [SHELL_TOOL_NAME]: SquareTerminalIcon,
  [SHELL_OUTPUT_TOOL_NAME]: SquareTerminalIcon,
  [KILL_SHELL_TOOL_NAME]: SquareTerminalIcon,
  [TASK_TOOL_NAME]: NetworkIcon,
  [WRITE_PLAN_TOOL_NAME]: ClipboardListIcon,
  [EDIT_PLAN_TOOL_NAME]: ClipboardListIcon,
  [ENTER_PLAN_MODE_TOOL_NAME]: ClipboardListIcon,
  [EXIT_PLAN_MODE_TOOL_NAME]: ClipboardListIcon,
  [WRITE_TODO_TOOL_NAME]: ListTodoIcon,
  [EDIT_TODO_TOOL_NAME]: ListTodoIcon,
  [ASK_TOOL_NAME]: CircleHelpIcon,
  [YIELD_TOOL_NAME]: ForwardIcon,
  [LIST_SKILLS_TOOL_NAME]: LibraryIcon,
  [READ_SKILL_TOOL_NAME]: BookOpenTextIcon,
  [SEARCH_MCP_TOOLS_NAME]: PlugIcon,
  [CALL_MCP_TOOL_NAME]: PlugIcon,
  [MCP_PROTOCOL_TOOL_NAME]: PlugIcon,
  [READ_MCP_OUTPUT_TOOL_NAME]: PlugIcon,
}

/** Renders a consistent decorative icon for a built-in tool. */
export function ToolIcon({ name }: { name: string }) {
  const icons: Partial<Record<string, LucideIcon>> = TOOL_ICONS
  const Icon = Object.hasOwn(icons, name) ? icons[name] : undefined
  if (!Icon) return null

  return (
    <Icon
      aria-hidden="true"
      className="text-muted-foreground size-3.5 shrink-0"
    />
  )
}
