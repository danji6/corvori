import type { ShellRetry } from '@cv/core/shell/retry'

import type { StartShellJobInput } from '../job-protocol'

function identity(job: StartShellJobInput) {
  return JSON.stringify([
    job.sessionId,
    job.owner,
    job.workspaceId,
    job.revision,
    job.agentId,
    job.homeId,
    job.command,
    job.cwd,
    job.shell,
    job.boundSessionDir,
    job.authority,
  ])
}

/** Bind a single replay to the failed process and the authority used to launch it. */
export class ShellRetryAuthorization {
  readonly cwd: string
  private readonly original: string
  private spent = false
  private pending?: { toolCallId: string; access: ShellRetry['access'] }

  constructor(input: StartShellJobInput) {
    this.cwd = input.cwd
    this.original = identity(input)
  }

  get available() {
    return !this.spent
  }

  private check(input: StartShellJobInput) {
    if (this.spent) throw new Error('This job already used its one-time retry')
    if (identity(input) !== this.original)
      throw new Error('The original shell invocation or workspace has changed')
    if (!input.toolCallId || !input.retry)
      throw new Error('Missing retry request')
    return { toolCallId: input.toolCallId, access: input.retry.access }
  }

  request(input: StartShellJobInput) {
    this.pending = this.check(input)
  }

  consume(input: StartShellJobInput) {
    const request = this.check(input)
    if (
      this.pending?.toolCallId !== request.toolCallId ||
      this.pending.access !== request.access
    )
      throw new Error('This retry request has expired')
    this.spent = true
    return request.access
  }
}
