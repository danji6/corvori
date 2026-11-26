import { ASK_TOOL_NAME } from '@cv/core/const'
import { TOOL_DESCRIPTIONS } from '@cv/core/types'

import { askFields, askOutputSchema } from './collaborationFields'

/** Builds the client-executed tool that pauses a turn for human input. */
export async function createAskTool() {
  const [{ tool }, { z }] = await Promise.all([import('ai'), import('zod')])

  return tool({
    description: TOOL_DESCRIPTIONS[ASK_TOOL_NAME],
    inputSchema: z.object(askFields),
    outputSchema: askOutputSchema,
  })
}
