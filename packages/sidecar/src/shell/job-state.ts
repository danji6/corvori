import type { ShellDenial } from '@cv/core/shell/retry'

import { type ShellJobStatus } from './job-protocol'
import { type OutputRing } from './output-ring'
import { type ShellJobProcess } from './pty'
import type { ShellRetryAuthorization } from './sandbox/retry'
import { type ShellJobSubscriber } from './subscriber'

export type ShellJob = {
  collectingDenials?: Promise<void>
  sandboxDenials?: ShellDenial[]
  retryAuthorization?: ShellRetryAuthorization
  retryOf?: string
  agentId?: string
  homeId?: string
  jobId: string
  sessionId: string
  owner?: string
  messageId?: string
  messageCreatedAt?: number
  toolCallId?: string
  workspaceId: string
  roots?: string[]
  command: string
  proc: ShellJobProcess
  ring: OutputRing
  status: ShellJobStatus
  endReason?: 'killed'
  exitCode: number | null
  background: boolean
  allowInteractiveShells: boolean
  /** Job is waiting on terminal input (blocked stdin read or alt screen). */
  waiting: boolean
  stdinWait: boolean
  altScreen: boolean
  altCarry: string
  waitProbe?: ReturnType<typeof setInterval>
  startedAt: number
  exitedAt?: number
  subscribers: Set<ShellJobSubscriber>
}
