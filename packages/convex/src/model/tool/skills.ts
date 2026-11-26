import { LIST_SKILLS_TOOL_NAME, READ_SKILL_TOOL_NAME } from '@cv/core/const'
import { TOOL_DESCRIPTIONS } from '@cv/core/types'

import { internal } from '../../_generated/api'
import type { ActionCtx } from '../../_generated/server'
import type { StreamExecutionArgs } from '../../validators/streams'
import { listSkillsFields, readSkillFields } from './skillFields'

export type SkillsContext = {
  ctx: ActionCtx
  execution: StreamExecutionArgs
  toolNames: string[]
}

export async function createListSkillsTool(skillsCtx: SkillsContext) {
  const [{ tool }, { z }] = await Promise.all([import('ai'), import('zod')])
  const { ctx, execution, toolNames } = skillsCtx

  return tool({
    description:
      TOOL_DESCRIPTIONS[LIST_SKILLS_TOOL_NAME] +
      (toolNames.includes(READ_SKILL_TOOL_NAME)
        ? ' Pass a skill_id to read_skill to open it.'
        : ''),
    inputSchema: z.object(listSkillsFields),
    execute: async (input) => {
      const { catalogForTool, resolvePersonalWorkspace } =
        await import('../skills/runtime')

      const live = await ctx.runQuery(
        internal.toolkits._skillContext,
        execution,
      )

      const current = await resolvePersonalWorkspace(live.agent, live.workspace)
      const page = await catalogForTool(
        ctx,
        live.agent._id,
        current,
        input,
        live.sessionId,
      )
      return {
        ...page,
        entries: page.entries.map(
          ({ name, description, origin, skill_id, error }) => ({
            name,
            description,
            origin,
            skill_id,
            error,
          }),
        ),
      }
    },
  })
}

/** Reads enabled skill bundles through their origin-specific authorization. */
export async function createReadSkillTool(context: SkillsContext) {
  const [{ tool }, { z }] = await Promise.all([import('ai'), import('zod')])
  return tool({
    description: TOOL_DESCRIPTIONS[READ_SKILL_TOOL_NAME],
    inputSchema: z.strictObject(readSkillFields),
    execute: async (input) => {
      const { readSkill } = await import('../skills/read')
      return readSkill(context.ctx, context.execution, input)
    },
  })
}
