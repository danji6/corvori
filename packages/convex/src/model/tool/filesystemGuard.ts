import {
  EDIT_FILE_TOOL_NAME,
  KILL_SHELL_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  SHELL_OUTPUT_TOOL_NAME,
  SHELL_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
} from '@cv/core/const'
import { shellRetry } from '@cv/core/shell/retry'
import type { ToolExecutionOptions, ToolSet } from 'ai'

import { internal } from '../../_generated/api'
import type { ActionCtx } from '../../_generated/server'
import { ToolError } from '../../errors'
import type { StreamExecutionArgs } from '../../validators/streams'
import type { WorkspaceToolContext } from './context'

type FilesystemExecution = {
  ctx?: ActionCtx
  execution?: StreamExecutionArgs
}

const FILESYSTEM_TOOLS = new Set([
  READ_FILE_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
  EDIT_FILE_TOOL_NAME,
  SHELL_TOOL_NAME,
  SHELL_OUTPUT_TOOL_NAME,
  KILL_SHELL_TOOL_NAME,
])

/** Keeps tools on the wire while rejecting calls without current filesystem access. */
export function guardFilesystemTool(
  name: string,
  tool: ToolSet[string],
  workspace?: WorkspaceToolContext,
  options?: FilesystemExecution,
): ToolSet[string] {
  if (!FILESYSTEM_TOOLS.has(name)) return tool

  const assertAccess = async (input: unknown) => {
    if (options?.ctx && options.execution) {
      const live = await options.ctx.runQuery(
        internal.streams._getFilesystemContext,
        options.execution,
      )
      if (name === SHELL_TOOL_NAME && shellRetry(input)) {
        const bound = workspace?.workspace
        if (
          live.workspace?.folderId !== bound?.folderId ||
          live.workspace?.revision !== bound?.revision
        )
          throw new ToolError(
            'The workspace changed while the retry was pending',
          )
      }
    }
    if (!workspace?.workspace)
      throw new ToolError('No filesystem context configured')
  }

  const execute = tool.execute
  const needsApproval = tool.needsApproval

  return {
    ...tool,
    needsApproval: async (
      input: unknown,
      execution: ToolExecutionOptions<unknown>,
    ) => {
      await assertAccess(input)
      return typeof needsApproval === 'function'
        ? needsApproval(input, execution)
        : !!needsApproval
    },
    execute: !execute
      ? undefined
      : name === SHELL_TOOL_NAME || name === SHELL_OUTPUT_TOOL_NAME
        ? async function* (input, execution) {
            await assertAccess(input)
            yield* execute(input, execution) as AsyncIterable<unknown>
          }
        : async (input, execution) => {
            await assertAccess(input)
            return execute(input, execution)
          },
  }
}
