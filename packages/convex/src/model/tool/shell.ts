import type { ShellToolOutput } from '@cv/core/types/tools'

import { postSidecar } from '../sidecar'
import { type ShellJobContext } from './shellContracts'
import { type ShellJobInput } from './shellContracts'
import { type ShellOutputInput } from './shellContracts'
import { type PostSidecar } from './shellContracts'
import { type ShellJobOptions } from './shellContracts'
import { type ShellJobResume } from './shellContracts'
import { TermOutputAccumulator, lostOutput } from './shellOutput'
import { readShellPage } from './shellPage'
import { shellWaitSeconds, waitForShell } from './shellTimedWait'
import { isJobNotFound, watchJob } from './shellWatch'

export type { ShellJobContext } from './shellContracts'
export type { ShellJobInput } from './shellContracts'
export type { ShellOutputInput } from './shellContracts'
export type { PostSidecar } from './shellContracts'
export type { OpenStream } from './shellContracts'
export type { ShellJobOptions } from './shellContracts'
export type { ShellJobResume } from './shellContracts'
export { shellToModelOutput } from './shellOutput'
export { shellHistoryTools } from './shellOutput'

type StartResponse = { jobId: string; mode: string; sandboxCwd?: string }

export function shellLaunchRequest(
  context: ShellJobContext,
  input: ShellJobInput,
  options: ShellJobOptions,
) {
  return {
    sessionId: context.sessionId,
    owner: context.owner,
    messageId: context.messageId,
    messageCreatedAt: context.messageCreatedAt,
    toolCallId: context.toolCallId,
    workspaceId: context.workspaceId,
    workspace: context.workspace,
    command: input.command,
    ...(options.bindSessionDir && { bindSessionDir: true }),
    cwd: input.cwd,
    allowedPaths: context.allowedPaths,
    background: input.wait_seconds === 0,
    ...(options.sandbox && { sandbox: true }),
    ...(options.retry && { retry: options.retry }),
    shell: context.shell,
    allowInteractiveShells: context.allowInteractiveShells ?? false,
  }
}

/**
 * Runs a command as a sidecar job. Yields preliminary output in `term`
 * and the final output in `text`.
 */
export async function* executeShellJob(
  context: ShellJobContext,
  input: ShellJobInput,
  options: ShellJobOptions = {},
): AsyncGenerator<ShellToolOutput> {
  const post = options.post ?? postSidecar
  const wait =
    input.wait_seconds === undefined
      ? undefined
      : shellWaitSeconds(input.wait_seconds)
  const background = wait === 0

  const { jobId, sandboxCwd } = await post<StartResponse>(
    '/shell/start',
    shellLaunchRequest(context, input, options),
  )

  const jobNumber = await options.onStarted?.(jobId)

  if (background) {
    yield {
      jobId,
      ...(jobNumber != null && { jobNumber }),
      status: 'background',
      exitCode: null,
      text: `Started background job ${jobNumber ?? jobId}. The job reports back on exit. Use shell_output to inspect progress or kill_shell to stop it.`,
      term: '',
      termOffset: 0,
    }
    return
  }

  const outputs =
    wait !== undefined
      ? waitForShell(context, jobId, Date.now() + wait * 1000, options, true)
      : watchJob(context, jobId, { ...options, post, detachOnBackground: true })

  for await (const output of outputs) {
    const result = jobNumber == null ? output : { ...output, jobNumber }
    if (
      sandboxCwd &&
      !options.retry &&
      output.status === 'done' &&
      output.exitCode
    ) {
      yield {
        ...result,
        text:
          output.text +
          '\nSandbox job ' +
          (jobNumber ?? jobId) +
          ' ran in ' +
          sandboxCwd +
          '. If additional access is needed, request a one-time retry with this cwd and explain why.',
      }
    } else yield result
  }
}

/**
 * Resumes watching a job that outlived its previous watcher. The scrollback
 * carries over and `term`/`termOffset` stay continuous for the reader.
 */
export async function* resumeShellJob(
  context: ShellJobContext,
  resume: ShellJobResume,
  options: ShellJobOptions = {},
): AsyncGenerator<ShellToolOutput> {
  const outputs = watchJob(context, resume.jobId, {
    ...options,
    post: options.post ?? postSidecar,
    detachOnBackground: true,
    seed: resume,
  })
  for await (const output of outputs) {
    yield resume.jobNumber === undefined
      ? output
      : { ...output, jobNumber: resume.jobNumber }
  }
}

/** Watches a background job until it exits or the window runs out. */
export async function* watchBackgroundJob(
  context: ShellJobContext,
  resume: ShellJobResume,
  options: ShellJobOptions = {},
): AsyncGenerator<ShellToolOutput> {
  yield* watchJob(context, resume.jobId, {
    ...options,
    post: options.post ?? postSidecar,
    seed: resume,
  })
}

export async function* executeShellOutput(
  context: ShellJobContext,
  input: ShellOutputInput,
  options: ShellJobOptions = {},
): AsyncGenerator<ShellToolOutput> {
  try {
    yield* readShellPage(context, input, options)
  } catch (error) {
    if (!isJobNotFound(error)) throw error
    yield lostOutput(input.jobId, new TermOutputAccumulator())
  }
}

export async function killShell(
  context: ShellJobContext,
  jobId: string,
  post: PostSidecar = postSidecar,
): Promise<string> {
  await post('/shell/kill', { sessionId: context.sessionId, jobId })
  return `Killed job ${jobId}`
}

export async function* shellFailure(
  message: string,
): AsyncGenerator<ShellToolOutput> {
  yield {
    jobId: '',
    status: 'killed',
    exitCode: null,
    text: message,
    term: '',
    termOffset: 0,
  }
}
