'use node'

import type { ShellToolOutput } from '@cv/core/types/tools'

import { internal } from '../../_generated/api'
import type { ActionCtx } from '../../_generated/server'
import { sanitizeChatError } from '../../errors'
import type { StreamExecutionArgs } from '../../validators/streams'
import { watchForStop } from './engineWatchdog'

/** Completes interrupted waits before issuing another model request. */
export async function resumeShellWaits(
  ctx: ActionCtx,
  execution: StreamExecutionArgs,
  windowDeadline: number,
) {
  const pending = await ctx.runQuery(
    internal.shellJobs._pendingWaits,
    execution,
  )
  if (!pending) return 'none' as const

  const { waitForShell } = await import('../tool/shellTimedWait')
  const { parts, ...context } = pending
  const controller = new AbortController()
  const watcher = watchForStop(ctx, execution, controller)

  try {
    const settled = await Promise.all(
      parts.map(async (part) => {
        const { jobId, jobNumber, waitUntil } = part.output
        const launch = part.type === 'tool-shell'
        const target = { ...execution, toolCallId: part.toolCallId }

        try {
          await ctx.runQuery(internal.streams._getFilesystemContext, execution)
          const readPosition = await ctx.runQuery(
            internal.shellOutputDeliveries._position,
            { ...execution, jobId },
          )
          let output: ShellToolOutput | undefined
          for await (const next of waitForShell(
            context,
            jobId,
            waitUntil,
            {
              abortSignal: controller.signal,
              windowDeadline,
              readPosition: readPosition ?? undefined,
            },
            launch,
          )) {
            output = next
          }
          if (
            !output ||
            output.status === 'running' ||
            controller.signal.aborted
          )
            return false
          return await ctx.runMutation(internal.shellJobs._finishWait, {
            ...target,
            output: { ...output, jobNumber },
          })
        } catch (cause) {
          if (controller.signal.aborted) return false
          return ctx.runMutation(internal.shellJobs._finishWait, {
            ...target,
            errorText: sanitizeChatError(cause),
          })
        }
      }),
    )
    return settled.every(Boolean) ? ('settled' as const) : ('pending' as const)
  } finally {
    watcher.dispose()
  }
}
