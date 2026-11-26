import { TASK_TOOL_NAME } from '@cv/core/const'
import { TOOL_DESCRIPTIONS } from '@cv/core/types'

import { taskFields } from './collaborationFields'

/**
 * Delegates a task to a spawnable sub-agent. The engine spawns a hidden
 * background child session and settles the tool part with a started
 * acknowledgment, and the child's report arrives later as its own
 * message in the parent session (see model/stream/subagents.ts).
 */
export async function createTaskTool(roster: string) {
  const [{ tool }, { z }] = await Promise.all([import('ai'), import('zod')])

  return tool({
    description: `${TOOL_DESCRIPTIONS[TASK_TOOL_NAME]}\n\nAvailable agents:\n${roster}`,
    inputSchema: z.object(taskFields),
  })
}
