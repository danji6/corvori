import { YIELD_TOOL_NAME } from '@cv/core/const'
import { TOOL_DESCRIPTIONS } from '@cv/core/types'

import { yieldFields, yieldOutputSchema } from './collaborationFields'

/** Builds the client-executed tool that hands the next turn to another agent. */
export async function createYieldTool() {
  const [{ tool }, { z }] = await Promise.all([import('ai'), import('zod')])

  return tool({
    description: TOOL_DESCRIPTIONS[YIELD_TOOL_NAME],
    inputSchema: z.object(yieldFields),
    outputSchema: yieldOutputSchema,
  })
}
