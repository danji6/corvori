import {
  KILL_SHELL_TOOL_NAME,
  SHELL_OUTPUT_TOOL_NAME,
  SHELL_TOOL_NAME,
} from '@cv/core/const'
import { hasGitHubQueryGrant } from '@cv/core/shell/direct-command'
import { TOOL_DESCRIPTIONS, shellToolDescription } from '@cv/core/types'
import type { ShellToolOutput, ToolApprovals } from '@cv/core/types/tools'
import { parseScopedPath } from '@cv/core/workspace/scoped-path'

import { ToolError } from '../../errors'
import {
  analyzeShellPathCandidates,
  isReadOnlyShellCommand,
  isToolAutoApproved,
  isUnrestrictedAccess,
} from '../../lib/tool/approval'
import { getSidecar, postSidecar } from '../sidecar'
import {
  type WatchedJobRef,
  type WorkspaceToolContext,
  workspaceArgs,
} from './context'
import { approvalsForFilesystemCall } from './filesystemApprovals'
import { checkShellToolPaths, checkToolPaths } from './paths'
import {
  type ShellJobInput,
  type ShellOutputInput,
  executeShellJob,
  executeShellOutput,
  killShell,
  shellLaunchRequest,
  shellToModelOutput,
} from './shell'
import {
  killShellFields,
  shellFields,
  shellOutputFields,
  shellRetryField,
} from './shellFields'
import { shellWaitSeconds, waitForShell } from './shellTimedWait'

export async function createShellTool(context: WorkspaceToolContext) {
  const [{ tool }, { z }] = await Promise.all([import('ai'), import('zod')])
  const capability =
    context.workspace && context.findShell ? await shellCapability() : undefined
  const automatic =
    capability?.version === 2 && capability.automaticShellExecution === true
  const preview =
    automatic || (capability?.version === 1 && capability.retryPreview)
  const fallbackRequests = new Set<string>()

  async function needsLaunchApproval(
    input: ShellJobInput,
    current: WorkspaceToolContext,
    toolCallId: string,
  ) {
    fallbackRequests.delete(toolCallId)
    if (input.retry) return true
    const approvals = await current.approvals?.()
    if (isUnrestrictedAccess(approvals)) return false
    if (
      !automatic ||
      !supportsSandboxShell(current.shell) ||
      (await current.isPlanMode?.())
    )
      return shellNeedsApproval(input.command, current, input.cwd)
    const probe = await postSidecar<{ ready: boolean }>(
      '/shell/sandbox/check',
      {
        ...workspaceArgs(current),
        command: input.command,
        allowedPaths: approvals?.paths,
      },
    ).catch(() => undefined)
    if (!probe?.ready) {
      fallbackRequests.add(toolCallId)
      return true
    }
    if (!input.cwd) return false
    const result = await checkToolPaths([], current, approvals?.paths, {
      cwd: input.cwd,
    })
    return !result?.complete || result.uncovered.length > 0
  }

  async function launch(
    input: ShellJobInput,
    toolCallId: string,
    approvals: ToolApprovals | undefined,
  ) {
    const planMode = await context.isPlanMode?.()
    const enforced =
      automatic &&
      supportsSandboxShell(context.shell) &&
      !fallbackRequests.has(toolCallId)
    const sandbox =
      !isUnrestrictedAccess(approvals) &&
      (enforced || (preview && !automatic && !planMode))
    if (input.retry && (!sandbox || planMode))
      throw new ToolError('Sandbox retry is unavailable in this mode')
    const cwdGrant =
      input.cwd &&
      (!enforced || isUnrestrictedAccess(approvals)) &&
      !parseScopedPath(input.cwd).explicit
        ? [input.cwd]
        : []
    fallbackRequests.delete(toolCallId)
    const job = {
      ...workspaceArgs(context),
      ...jobRef(context, toolCallId),
      allowedPaths: [...(approvals?.paths ?? []), ...cwdGrant],
    }
    const ref =
      input.retry && (await requireShellReference(context, input.retry.jobId))
    const retry = input.retry && ref && { ...input.retry, jobId: ref.jobId }
    return {
      job,
      options: {
        sandbox: sandbox ? (true as const) : undefined,
        requireSandbox: sandbox && enforced ? (true as const) : undefined,
        readOnlyWorkspace: sandbox && planMode ? (true as const) : undefined,
        githubQuery:
          sandbox &&
          enforced &&
          !planMode &&
          hasGitHubQueryGrant(input.command, approvals?.shell)
            ? (true as const)
            : undefined,
        retry,
        bindSessionDir: shouldBindSessionDir(input.command, context),
      },
    }
  }

  return tool<ShellJobInput, ShellToolOutput, never>({
    description: shellToolDescription(
      context.shell,
      context.hasAgentHome ?? !!context.workspace?.agentHome,
    ),
    inputSchema: z.strictObject(
      preview ? { ...shellFields, retry: shellRetryField } : shellFields,
    ),
    needsApproval: async (input, execution) => {
      if (!input.retry)
        return automatic
          ? needsLaunchApproval(input, context, execution.toolCallId)
          : shellNeedsApproval(input.command, context, input.cwd)
      const { job, options } = await launch(
        input,
        execution.toolCallId,
        await context.approvals?.(),
      )
      if (!input.cwd || !input.description?.trim())
        throw new ToolError(
          'A sandbox retry requires the original working directory and a reason for the requested access',
        )
      await postSidecar(
        '/shell/retry/check',
        shellLaunchRequest(job, input, options),
      )
      return true
    },
    toModelOutput: shellToModelOutput,
    execute: async function* (input, { abortSignal, toolCallId }) {
      const approvals = await approvalsForFilesystemCall(
        context,
        { id: toolCallId, name: SHELL_TOOL_NAME, input },
        (current) => needsLaunchApproval(input, current, toolCallId),
      )
      const { job, options } = await launch(input, toolCallId, approvals)
      yield* trackJob(
        executeShellJob(
          job,
          {
            ...input,
            wait_seconds: shellWaitSeconds(input.wait_seconds),
          },
          {
            abortSignal,
            ...options,
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

async function shellCapability() {
  const info = await getSidecar<{
    sandbox?: {
      version: number
      retryPreview?: boolean
      automaticShellExecution?: boolean
    }
  }>('/shell/info').catch(() => undefined)
  return info?.sandbox
}

function supportsSandboxShell(shell?: string) {
  return !shell || /^(?:\/bin\/)?(?:sh|bash|zsh)$/.test(shell)
}

function shouldBindSessionDir(
  command: string,
  context: WorkspaceToolContext,
): true | undefined {
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
