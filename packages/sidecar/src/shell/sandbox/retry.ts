import type { ShellRetryAccess } from '@cv/core/shell/retry'

import type { StartShellJobInput } from '../job-protocol'

type Attempt = Pick<
  StartShellJobInput,
  | 'sessionId'
  | 'owner'
  | 'workspaceId'
  | 'revision'
  | 'agentId'
  | 'homeId'
  | 'command'
  | 'cwd'
  | 'shell'
  | 'boundSessionDir'
  | 'authority'
>

/** Bind a single replay to the failed process and the authority used to launch it. */
export class ShellRetryAuthorization {
  private consumed = false
  private pending?: { toolCallId: string; access: ShellRetryAccess }

  constructor(private readonly original: Attempt) {}

  check(input: Attempt) {
    if (this.consumed)
      throw new Error('This job already used its one-time retry')
    const keys = Object.keys(this.original) as (keyof Attempt)[]
    if (keys.some((key) => this.original[key] !== input[key]))
      throw new Error('The original shell invocation or workspace has changed')
  }

  request(input: StartShellJobInput) {
    if (!input.toolCallId || !input.retry)
      throw new Error('Missing retry request')
    this.check(input)
    this.pending = { toolCallId: input.toolCallId, access: input.retry.access }
  }

  consume(input: StartShellJobInput, access: ShellRetryAccess) {
    if (
      !this.pending ||
      this.pending.toolCallId !== input.toolCallId ||
      this.pending.access !== access
    )
      throw new Error('This retry request has expired')
    this.check(input)
    this.consumed = true
    return access
  }
}

export function attemptIdentity(input: StartShellJobInput): Attempt {
  const {
    sessionId,
    owner,
    workspaceId,
    revision,
    agentId,
    homeId,
    command,
    cwd,
    shell,
    boundSessionDir,
    authority,
  } = input
  return {
    sessionId,
    owner,
    workspaceId,
    revision,
    agentId,
    homeId,
    command,
    cwd,
    shell,
    boundSessionDir,
    authority,
  }
}
