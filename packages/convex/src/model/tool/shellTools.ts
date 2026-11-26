import {
  KILL_SHELL_TOOL_NAME,
  SHELL_OUTPUT_TOOL_NAME,
  SHELL_TOOL_NAME,
} from '@cv/core/const'
import { TOOL_DESCRIPTIONS, shellToolDescription } from '@cv/core/types'
import type { ShellToolOutput } from '@cv/core/types/tools'
import { parseScopedPath } from '@cv/core/workspace/scoped-path'

import { ToolError } from '../../errors'
import {
  analyzeShellPathCandidates,
  isReadOnlyShellCommand,
  isToolAutoApproved,
  isUnrestrictedAccess,
} from '../../lib/tool/approval'
import {
  type WatchedJobRef,
  type WorkspaceToolContext,
  workspaceArgs,
} from './context'
import { checkShellToolPaths } from './paths'
import {
  type ShellJobInput,
  type ShellOutputInput,
  executeShellJob,
  executeShellOutput,
  killShell,
  shellToModelOutput,
} from './shell'
import { killShellFields, shellFields, shellOutputFields } from './shellFields'
import { shellWaitSeconds, waitForShell } from './shellTimedWait'

export async function createShellTool(context: WorkspaceToolContext) {
  const [{ tool }, { z }] = await Promise.all([import('ai'), import('zod')])
  return tool<ShellJobInput, ShellToolOutput, never>({
    description: shellToolDescription(
      context.shell,
      context.hasAgentHome ?? !!context.workspace?.agentHome,
    ),
    inputSchema: z.strictObject(shellFields),
    needsApproval: (input) =>
      shellNeedsApproval(input.command, context, input.cwd),
    toModelOutput: shellToModelOutput,
    execute: async function* (input, { abortSignal, toolCallId }) {
      const approvals = await context.approvals?.()
      // Reaching execute means this invocation passed its approval gate
      const cwdGrant =
        input.cwd && !parseScopedPath(input.cwd).explicit ? [input.cwd] : []
      const allowedPaths = [...(approvals?.paths ?? []), ...cwdGrant]
      yield* trackJob(
        executeShellJob(
          {
            ...workspaceArgs(context),
            ...jobRef(context, toolCallId),
            allowedPaths,
          },
          {
            ...input,
            wait_seconds: shellWaitSeconds(input.wait_seconds),
          },
          {
            abortSignal,
            bindSessionDir: shouldBindSessionDir(input.command, context),
            windowDeadline: context.shellWindowDeadline,
            onStarted:
              context.bindShell &&
              ((jobId) => context.bindShell!(jobId, toolCallId, input.command)),
          },
        ),
        context,
        { command: input.command, toolCallId },
      )
    },
  })
}

function shouldBindSessionDir(command: string, context: WorkspaceToolContext) {
  if (!context.workspace?.sessionFiles || !command.includes('SESSION_DIR'))
    return undefined
  const { complete, sessionPaths } = analyzeShellPathCandidates(command)
  return complete && sessionPaths ? true : undefined
}

export async function createShellOutputTool(context: WorkspaceToolContext) {
  const [{ tool }, { z }] = await Promise.all([import('ai'), import('zod')])
  return tool<ShellOutputInput, ShellToolOutput, never>({
    description: TOOL_DESCRIPTIONS[SHELL_OUTPUT_TOOL_NAME],
    inputSchema: z.object(shellOutputFields),
    toModelOutput: shellToModelOutput,
    execute: async function* (input, { abortSignal }) {
      const ref = await requireShellReference(context, input.jobId)
      const { jobId } = ref
      const wait =
        input.offset === undefined ? shellWaitSeconds(input.wait_seconds) : 0
      const jobContext = workspaceArgs(context)
      if (wait > 0) await context.releaseJob?.(jobId)
      const readPosition = await context.readShellPosition?.(
        jobId,
        input.offset,
      )
      const options = {
        abortSignal,
        readPosition,
        windowDeadline: context.shellWindowDeadline,
      }
      const outputs =
        wait > 0
          ? waitForShell(
              jobContext,
              jobId,
              Date.now() + wait * 1000,
              options,
              false,
            )
          : executeShellOutput(
              jobContext,
              { ...input, jobId, wait_seconds: 0 },
              options,
            )

      yield* trackJob(withJobNumber(outputs, ref.number), context, {
        command: ref.command,
        toolCallId: ref.toolCallId,
        deferRelease: !!context.readShellPosition,
      })
    },
  })
}

export async function createKillShellTool(context: WorkspaceToolContext) {
  const [{ tool }, { z }] = await Promise.all([import('ai'), import('zod')])
  return tool({
    description: TOOL_DESCRIPTIONS[KILL_SHELL_TOOL_NAME],
    inputSchema: z.object(killShellFields),
    execute: async ({ jobId: handle }) => {
      const { jobId } = await requireShellReference(context, handle)
      // Killing it is the agent saying it no longer wants the result
      await context.releaseJob?.(jobId)
      await killShell(workspaceArgs(context), jobId)
      return `Killed job ${handle}`
    },
  })
}

async function requireShellReference(
  context: WorkspaceToolContext,
  handle: string,
) {
  const ref = await context.findShell?.(handle)
  if (!ref) throw new ToolError(`Job ${handle} was not found in this chat.`)
  return ref
}

/**
 * Passes a shell tool's output through, then settles the job's watch by its
 * final state.
 */
export async function* trackJob(
  outputs: AsyncGenerator<ShellToolOutput>,
  context: WorkspaceToolContext,
  ref: Omit<WatchedJobRef, 'jobId'> & { deferRelease?: boolean },
): AsyncGenerator<ShellToolOutput> {
  let last: ShellToolOutput | undefined
  for await (const output of outputs) {
    last = output
    if (ref.deferRelease && output.status !== 'running') {
      await context.saveShellTerminal?.(output)
    }
    yield output
  }

  if (!last?.jobId || last.status === 'running') return
  if (last.status === 'background') {
    await context.watchJob?.({
      command: ref.command,
      toolCallId: ref.toolCallId,
      jobId: last.jobId,
    })
  } else if (!ref.deferRelease) {
    await context.releaseJob?.(last.jobId)
  }
}

/** Lets the UI find a running job's terminal without its tool output. */
function jobRef(context: WorkspaceToolContext, toolCallId: string) {
  return {
    messageId: context.messageId,
    messageCreatedAt: context.messageCreatedAt,
    toolCallId,
  }
}

async function shellNeedsApproval(
  command: string,
  context: WorkspaceToolContext,
  cwd?: string,
): Promise<boolean> {
  const approvals = await context.approvals?.()
  if (isUnrestrictedAccess(approvals)) return false
  if (!isReadOnlyShellCommand(command) && (await context.isPlanMode?.())) {
    return true
  }
  if (!isToolAutoApproved(SHELL_TOOL_NAME, { command }, approvals)) return true
  const result = await checkShellToolPaths(
    command,
    context,
    approvals?.paths,
    cwd,
  )
  return !result?.complete || result.uncovered.length > 0
}

async function* withJobNumber(
  outputs: AsyncGenerator<ShellToolOutput>,
  jobNumber: number,
) {
  for await (const output of outputs) {
    yield { ...output, jobNumber }
  }
}
