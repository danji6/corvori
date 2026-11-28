import {
  ASK_TOOL_NAME,
  ATTACH_FILE_TOOL_NAME,
  CALL_MCP_TOOL_NAME,
  CALL_TOOL_NAME,
  COPY_ATTACHMENT_TOOL_NAME,
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
  TASK_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
  WRITE_PLAN_TOOL_NAME,
  WRITE_TODO_TOOL_NAME,
  YIELD_TOOL_NAME,
} from '../const'
import { shellLabel } from '../shell/name'
import { inline } from '../utils/strings'

const webFetch = 'Fetch a web page and return its main content as markdown.'

const webSearch = 'Search the web and return a list of results.'

const readFile = inline`Read a bounded text page or inspect an image. Use only
  path for images. Use this instead of cat/sed for inspection. When the text is
  truncated, pass nextByteOffset as byteOffset to continue.`

const readAttachment = inline`
  Read or search an attachment. Start with reference. Use pattern (Go regexp
  using RE2 syntax) to find matching lines. If done is false, pass only
  operationId to continue. Search hits include a preview, byteOffset for the match,
  and lineStartOffset for the beginning of the line. Line numbers count from the
  start (line) or the end (lineFromEnd). To inspect a hit in context, start a
  plain read with reference and set offset to lineStartOffset.`

const copyAttachment = inline`
  Copy an attachment to a file you can work with to the session:// folder.`

const attachFile = inline`
  Publish a snapshot of a regular session:// file as a downloadable attachment
  in your response.`

const writeFile = inline`
  Create or overwrite a text file in the selected filesystem scope. Prefer
  edit_file for targeted changes.`

const editFile = inline`
  Edit a text file using exact, unique replacements. Pass the changes as
  \`edits: [{ oldText, newText }]\` (array of objects). Use one call with
  multiple edits for parallel changes in the same file. Keep oldText small but
  unique; include surrounding context if there are multiple occurrences. Merge
  nearby or overlapping changes into one edit.`

/** Adds personal file guidance only when a home is available for this turn. */
export function fileToolDescription(
  description: string,
  hasAgentHome = false,
  hasSessionFiles = false,
) {
  const home = hasAgentHome ? ' Use agent:// paths for personal files.' : ''
  const session = hasSessionFiles ? ' Use session:// paths for chat files.' : ''
  return description + home + session
}

export function shellToolDescription(
  shell?: string,
  hasAgentHome = false,
): string {
  const where = shell ? ` with ${shellLabel(shell)}` : ''
  const personal = hasAgentHome
    ? ' Set cwd to agent:// or an agent:// subdirectory to run in your personal folder.' +
      ' Paths inside command use normal shell syntax, not filesystem prefixes.' +
      ' AGENT_DIR and WORKSPACE_DIR environment variables provide available absolute roots'
    : 'The WORKSPACE_DIR environment variable provides the absolute root'
  return inline`
    Run a shell command${where} in cwd (default: primary project source).${personal}.
    Waits up to wait_seconds for exit and returns recent output. A job still
    running at the deadline continues in the background and reports when it
    exits. Pass a description whenever the command isn't self-explanatory, so
    the user can review it at a glance.`
}

const shellOutput = inline`
  Wait for a running job to exit or until wait_seconds elapses. Returns the
  latest unread output and current status. Background jobs report automatically
  on exit. Use offset only for immediate replay.`

const killShell = 'Kill a running shell job.'

const writePlan = inline`
  Create or overwrite the session plan. Use it for the initial draft or a
  complete rewrite; prefer edit_plan for targeted changes.`

const editPlan = inline`
  Edit the session plan using exact, unique replacements. Pass the changes as
  \`edits: [{ oldText, newText }]\` (array of objects). Use one call with
  multiple edits for parallel changes in different places.`

const enterPlanMode = inline`
  Enter plan mode. Use this when the task is large or ambiguous enough that
  researching and agreeing on a plan first would help.`

const exitPlanMode = inline`
  Present the current plan for user approval. Call this once the plan is
  complete.`

const writeTodo = inline`
  Create or replace the session todo list. Use it for substantial tasks of 3+
  steps. Tasks matching existing ones keep their status; an empty list clears
  the list. Update statuses with edit_todo.`

const editTodo = inline`
  Update todo statuses. Each edit names the exact text of an existing task and
  its new status. Mark a task 'doing' before starting it (one at a time) and
  'done' immediately when finished; never batch completions.`

const ask = inline`
  Ask the user one or more decision-blocking questions. Group related
  questions into one call. Provide 2-4 options for each question, mark at most
  one as recommended, and keep labels concise. Options are mutually exclusive
  by default; set multiple to true only when selecting several options makes
  sense. The user may choose options, add context, write a different answer,
  or skip a question.`

const _yield = inline`
  Yield the next turn to another agent in this conversation. Pass the name of
  the agent who should respond next. Call this last and on its own: your turn
  ends when the request is accepted.`

const task = [
  inline`
    Delegate a task to a sub-agent that works in its own separate session in the
    background. This call returns immediately with an acknowledgment; the
    sub-agent keeps working and its final report arrives later as a separate
    message in this conversation. You can keep working meanwhile. To wait for a
    report, simply stop responding to the user and end your turn.`,
  '',
  inline`
    Use tasks for research or self-contained subtasks to keep this conversation
    focused, and call it multiple times in one turn to run sub-agents in
    parallel. The sub-agent starts fresh, it sees only your prompt and cannot
    ask the user or you anything. Write a complete, specific prompt and state
    exactly what the final report should contain.`,
].join('\n')

const skills = inline`
  List enabled agent, project and toolkit skills. Use search to match a
  skill name or cursor to continue a page. Read the chosen SKILL.md before
  following its instructions.`

const readSkill = inline`
  Read SKILL.md or a bundled text resource from an available skill. Read
  SKILL.md before following related instructions.`

const getTool =
  'Read the current description and complete input schema of an enabled tool.'

const callTool =
  'Call an enabled tool by name with arguments matching its current input schema.'

const searchMcpTools = inline`
  Discover authorized MCP servers and tools, and retrieve tool definitions
  without loading the whole catalog. Large definitions return text fragments:
  concatenate all ranges until hasMore is false (nextOffset is null) before
  parsing or calling. inputSchemaComplete means this response contains the whole
  input contract; it is false for fragments, including the last fragment. Reuse
  a previously read input contract for the same callable name and catalogRevision.`

const callMcpTool = inline`
  Call an MCP tool using tool with name returned by search_mcp_tools and a JSON
  arguments object matching its input schema.`

const mcpProtocol = inline`
  Access an authorized MCP server's information, prompt templates, and resources.
  Select an operation using method and a server using its name from search_mcp_tools.
  Methods: get_server_info reads the server's identity, capabilities, and
  initialization instructions; list_prompts lists prompt templates; get_prompt
  retrieves a named prompt with optional arguments; list_resources lists
  available resources; list_resource_templates lists parameterized resource URI
  patterns; read_resource reads a resource by URI through the selected server.
  Lists follow every continuation page. Get prompts only when explicitly
  requested by the user. Resource reads do not fetch web links automatically.
  Use read_mcp_output for complete large results.`

const readMcpOutput = inline`
  Read the full MCP output in bounded character ranges. Supply output with the
  output name from an MCP result. Follow nextOffset until null before treating
  a large JSON result as complete. Partial ranges are literal fragments, not
  complete JSON.`

export const TOOL_DESCRIPTIONS = {
  [WEB_FETCH_TOOL_NAME]: webFetch,
  [WEB_SEARCH_TOOL_NAME]: webSearch,
  [READ_FILE_TOOL_NAME]: readFile,
  [READ_ATTACHMENT_TOOL_NAME]: readAttachment,
  [COPY_ATTACHMENT_TOOL_NAME]: copyAttachment,
  [ATTACH_FILE_TOOL_NAME]: attachFile,
  [WRITE_FILE_TOOL_NAME]: writeFile,
  [EDIT_FILE_TOOL_NAME]: editFile,
  [SHELL_OUTPUT_TOOL_NAME]: shellOutput,
  [KILL_SHELL_TOOL_NAME]: killShell,
  [WRITE_PLAN_TOOL_NAME]: writePlan,
  [EDIT_PLAN_TOOL_NAME]: editPlan,
  [ENTER_PLAN_MODE_TOOL_NAME]: enterPlanMode,
  [EXIT_PLAN_MODE_TOOL_NAME]: exitPlanMode,
  [WRITE_TODO_TOOL_NAME]: writeTodo,
  [EDIT_TODO_TOOL_NAME]: editTodo,
  [ASK_TOOL_NAME]: ask,
  [YIELD_TOOL_NAME]: _yield,
  [TASK_TOOL_NAME]: task,
  [LIST_SKILLS_TOOL_NAME]: skills,
  [READ_SKILL_TOOL_NAME]: readSkill,
  [GET_TOOL_NAME]: getTool,
  [CALL_TOOL_NAME]: callTool,
  [SEARCH_MCP_TOOLS_NAME]: searchMcpTools,
  [CALL_MCP_TOOL_NAME]: callMcpTool,
  [MCP_PROTOCOL_TOOL_NAME]: mcpProtocol,
  [READ_MCP_OUTPUT_TOOL_NAME]: readMcpOutput,
} as const
