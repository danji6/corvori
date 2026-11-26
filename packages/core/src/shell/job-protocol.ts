export type PtyMode = 'pty' | 'script' | 'pipe'

export type ShellJobStatus = 'running' | 'done' | 'killed'

export type StartShellJobInput = {
  agentId?: string
  homeId?: string
  sessionId: string
  /** Whoever's stop terminates this job. */
  owner?: string
  /** Message (tool call) this job belongs to. */
  messageId?: string
  messageCreatedAt?: number
  toolCallId?: string
  workspaceId: string
  command: string
  cwd: string
  environment?: {
    AGENT_DIR?: string
    WORKSPACE_DIR?: string
    SESSION_DIR?: string
  }
  boundSessionDir?: string
  background?: boolean
  cols?: number
  rows?: number
  shell?: string
  allowInteractiveShells?: boolean
}

export type ShellJobSummary = {
  agentId?: string
  homeId?: string
  jobId: string
  messageId?: string
  messageCreatedAt?: number
  toolCallId?: string
  command: string
  status: ShellJobStatus
  exitCode: number | null
  background: boolean
  waiting: boolean
  allowInteractiveShells?: boolean
  startedAt: number
  exitedAt?: number
  mode: PtyMode
}

export type PollResult = {
  chunk: string
  nextOffset: number
  bufferStart: number
  status: ShellJobStatus
  exitCode: number | null
  background: boolean
  waiting: boolean
  bufferEnd: number
  /** Present when the request includes `tailChars`. */
  term?: string
  termOffset?: number
}

export type ShellOutputSnapshot = PollResult & {
  term: string
  termOffset: number
}

export type ShellStreamEvent =
  | { type: 'chunk'; text: string; nextOffset: number }
  | { type: 'meta'; background: boolean; waiting: boolean }
  | { type: 'end'; status: ShellJobStatus; exitCode: number | null }
