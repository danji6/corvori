import { finishCheckpointJob } from '../checkpoints/manager'
import { isOutside } from '../mcp/workspace/access'
import { startWaitProbe } from './job-interaction'
import { trackAltScreen } from './job-interaction'
import { type ShellJobStatus } from './job-protocol'
import { type StartShellJobInput } from './job-protocol'
import { type ShellJobSummary } from './job-protocol'
import { type PollResult } from './job-protocol'
import { type ShellStreamEvent } from './job-protocol'
import { type ShellJob } from './job-state'
import { OutputRing } from './output-ring'
import { type PtyMode, spawnJob } from './pty'
import { readSeatbeltDenials } from './sandbox/denials'
import { preparePreview } from './sandbox/preview'
import { ShellRetryAuthorization } from './sandbox/retry'
import { ShellJobSubscriber } from './subscriber'
import { withBoundSessionDir } from './system-shell'

export type { ShellJobStatus } from './job-protocol'
export type { StartShellJobInput } from './job-protocol'
export type { ShellJobSummary } from './job-protocol'
export type { PollResult } from './job-protocol'
export type { RingSnapshot } from './output-ring'
export type { RingSubscription } from './output-ring'
export { OutputRing } from './output-ring'
export type { ShellStreamEvent } from './job-protocol'
export { ShellJobSubscriber } from './subscriber'

const MAX_RUNNING_PER_SESSION = 8

const FINISHED_JOB_TTL_MS = 30 * 60 * 1000

const SWEEP_INTERVAL_MS = 60 * 1000

const EXIT_FLUSH_MS = 50

const jobs = new Map<string, ShellJob>()

let sweeper: ReturnType<typeof setInterval> | undefined

function nextJobId(): string {
  return `shell-${crypto.randomUUID()}`
}

function ensureSweeper() {
  if (sweeper) return
  sweeper = setInterval(() => {
    const now = Date.now()
    for (const [jobId, job] of jobs) {
      if (job.exitedAt && now - job.exitedAt > FINISHED_JOB_TTL_MS) {
        jobs.delete(jobId)
      }
    }
  }, SWEEP_INTERVAL_MS)
  sweeper.unref?.()
}

function runningSessionJobs(sessionId: string): ShellJob[] {
  return [...jobs.values()].filter(
    (job) => job.sessionId === sessionId && job.status === 'running',
  )
}

export async function startShellJob(
  input: StartShellJobInput,
  roots: string[] = [input.cwd],
): Promise<{ jobId: string; mode: PtyMode }> {
  if (runningSessionJobs(input.sessionId).length >= MAX_RUNNING_PER_SESSION) {
    throw new Error(
      `Too many running jobs for this session (max ${MAX_RUNNING_PER_SESSION})`,
    )
  }

  const access = input.retry && checkShellRetry(input).consume(input)
  const preview = input.sandbox
    ? await preparePreview(input, [...new Set(roots)], access)
    : undefined
  const proc = await spawnJob({
    prepared: preview?.prepared,
    command: input.boundSessionDir
      ? withBoundSessionDir(input.command, input.boundSessionDir)
      : input.command,
    cwd: input.cwd,
    environment: input.environment,
    cols: input.cols ?? 80,
    rows: input.rows ?? 24,
    shell: input.shell,
  }).catch(async (error) => {
    await preview?.cleanup()
    throw error
  })

  const job: ShellJob = {
    jobId: nextJobId(),
    retryAuthorization:
      preview && !input.retry ? new ShellRetryAuthorization(input) : undefined,
    retryOf: input.retry?.jobId,
    agentId: input.agentId,
    homeId: input.homeId,
    sessionId: input.sessionId,
    owner: input.owner,
    messageId: input.messageId,
    messageCreatedAt: input.messageCreatedAt,
    toolCallId: input.toolCallId,
    workspaceId: input.workspaceId,
    roots,
    command: input.command,
    proc,
    ring: new OutputRing(),
    status: 'running',
    exitCode: null,
    background: input.background ?? false,
    allowInteractiveShells: input.allowInteractiveShells ?? false,
    waiting: false,
    stdinWait: false,
    altScreen: false,
    altCarry: '',
    startedAt: Date.now(),
    subscribers: new Set(),
  }

  proc.onData((chunk) => {
    job.ring.append(chunk)
    trackAltScreen(job, chunk)
  })

  startWaitProbe(job)

  proc.onExit((exitCode) => {
    if (exitCode && !job.endReason && preview?.tag) {
      job.collectingDenials = readSeatbeltDenials(
        preview.tag,
        job.startedAt,
      ).then((events) => {
        job.sandboxDenials = events
      })
    }
    void preview
      ?.cleanup()
      .catch(() =>
        console.error('Failed to remove shell job temporary directory'),
      )
    // Grace period after exit for the final output
    clearInterval(job.waitProbe)
    setTimeout(() => {
      job.exitCode = exitCode
      job.exitedAt = Date.now()
      job.waiting = false
      if (job.status === 'running') job.status = job.endReason ?? 'done'
      for (const sub of job.subscribers) sub.onEnd(job.status, job.exitCode)
      job.subscribers.clear()
      void finishCheckpointJob(job.sessionId, job.proc.pid).catch(() => {
        console.error('Failed to retire a completed checkpoint shell process')
      })
    }, EXIT_FLUSH_MS)
  })

  jobs.set(job.jobId, job)
  ensureSweeper()
  return { jobId: job.jobId, mode: proc.mode }
}

function requireJob(jobId: string, sessionId: string): ShellJob {
  const job = jobs.get(jobId)
  if (!job || job.sessionId !== sessionId) {
    throw new Error('Job not found for this session')
  }
  return job
}

export function checkShellRetry(input: StartShellJobInput) {
  if (!input.sandbox || !input.retry)
    throw new Error('Sandbox retry unavailable')
  const job = requireJob(input.retry.jobId, input.sessionId)
  if (job.status !== 'done' || job.exitCode === null || job.exitCode === 0)
    throw new Error(
      'Only a failed shell job can be retried with additional access',
    )
  if (!job.retryAuthorization)
    throw new Error('This job has no sandbox retry available')
  return job.retryAuthorization
}

/** Wait for native evidence only when returning a completed failure over HTTP. */
export function terminalShellEvidence(jobId: string, sessionId: string) {
  const job = requireJob(jobId, sessionId)
  if (job.status === 'done') return job.collectingDenials
}

export function pollShellJob(
  jobId: string,
  sessionId: string,
  offset: number,
  options: { limit?: number; tailChars?: number } = {},
): PollResult {
  const job = requireJob(jobId, sessionId)
  const { text, start, end } = job.ring.read(offset, options.limit)
  const bufferEnd = job.ring.endOffset
  const tail =
    options.tailChars === undefined
      ? undefined
      : job.ring.read(Math.max(0, bufferEnd - options.tailChars))
  return {
    chunk: text,
    nextOffset: end,
    bufferStart: start,
    status: job.status,
    exitCode: job.exitCode,
    background: job.background,
    waiting: job.waiting,
    bufferEnd,
    ...(job.status === 'done' &&
    job.exitCode &&
    job.retryAuthorization?.available
      ? {
          retryCwd: job.retryAuthorization.cwd,
          ...(job.sandboxDenials?.length && {
            sandboxDenials: job.sandboxDenials,
          }),
        }
      : {}),
    ...(tail && { term: tail.text, termOffset: tail.start }),
  }
}

export type ShellJobStream = {
  initial: { chunk: string; nextOffset: number; bufferStart: number }
  status: ShellJobStatus
  exitCode: number | null
  background: boolean
  waiting: boolean
  registered: boolean // false when the job already ended
  events: AsyncGenerator<ShellStreamEvent>
  unsubscribe: () => void
}

/**
 * Snapshots from `offset` and, if the job is still running, attaches live
 * output/status listeners in one synchronous block (no interleave with the
 * exit transition or an append).
 */
export function subscribeShellJob(
  jobId: string,
  sessionId: string,
  offset: number,
): ShellJobStream {
  const job = requireJob(jobId, sessionId)
  const sub = new ShellJobSubscriber(job.ring.read(offset).end)
  const registered = job.status === 'running'
  const { initial, unsubscribe: unsubRing } = job.ring.subscribe(
    offset,
    sub.onChunk,
  )
  if (registered) job.subscribers.add(sub)

  return {
    initial: {
      chunk: initial.text,
      nextOffset: initial.end,
      bufferStart: initial.start,
    },
    status: job.status,
    exitCode: job.exitCode,
    background: job.background,
    waiting: job.waiting,
    registered,
    events: sub.events(),
    unsubscribe: () => {
      unsubRing()
      job.subscribers.delete(sub)
      sub.cancel()
    },
  }
}

/** Detaches a running job so it survives stream cleanup and watchers stop blocking. */
export function backgroundShellJob(jobId: string, sessionId: string) {
  const job = requireJob(jobId, sessionId)
  if (job.status !== 'running') return
  job.background = true
  for (const sub of job.subscribers) sub.onMeta(true, job.waiting)
}

export function writeStdin(jobId: string, sessionId: string, data: string) {
  const job = requireJob(jobId, sessionId)
  if (job.status !== 'running') throw new Error('Job is not running')
  if (!job.allowInteractiveShells) {
    throw new Error('Interactive shells are disabled for this job')
  }
  job.proc.write(data)
}

export function killShellJob(jobId: string, sessionId: string) {
  const job = requireJob(jobId, sessionId)
  if (job.status !== 'running') return
  job.endReason = 'killed'
  job.proc.kill()
}

export function resizeShellJob(
  jobId: string,
  sessionId: string,
  cols: number,
  rows: number,
) {
  const job = requireJob(jobId, sessionId)
  job.proc.resize(cols, rows)
}

export function listShellJobs(sessionId: string): ShellJobSummary[] {
  return [...jobs.values()]
    .filter((job) => job.sessionId === sessionId)
    .map((job) => ({
      jobId: job.jobId,
      ...(job.retryOf && { retryOf: job.retryOf }),
      messageId: job.messageId,
      messageCreatedAt: job.messageCreatedAt,
      toolCallId: job.toolCallId,
      command: job.command,
      status: job.status,
      exitCode: job.exitCode,
      background: job.background,
      waiting: job.waiting,
      allowInteractiveShells: job.allowInteractiveShells,
      startedAt: job.startedAt,
      exitedAt: job.exitedAt,
      mode: job.proc.mode,
    }))
}

/** `owner` narrows the sweep to the jobs one turn started. */
export function killSessionShellJobs(
  sessionId: string,
  includeBackground: boolean,
  owner?: string,
): number {
  const targets = runningSessionJobs(sessionId).filter(
    (job) =>
      (includeBackground || !job.background) &&
      (owner === undefined || job.owner === owner),
  )
  for (const job of targets) {
    job.endReason = 'killed'
    job.proc.kill()
  }
  return targets.length
}

/** Detects jobs sharing a persistent home even when their sessions differ. */
export function hasRunningAgentJobs(agentId: string): boolean {
  return [...jobs.values()].some(
    (job) =>
      (job.homeId === agentId || job.agentId === agentId) &&
      job.status === 'running',
  )
}

/** Returns a started job's process identity for durable capture reservations. */
export function shellJobPid(jobId: string, sessionId: string) {
  return requireJob(jobId, sessionId).proc.pid
}

/** Stops owned subprocesses before the sidecar exits. */
export function killAllShellJobs() {
  for (const job of jobs.values()) {
    if (job.status !== 'running') continue
    job.endReason = 'killed'
    job.proc.kill()
  }
}

/** Detects older shell writers even when they predate checkpoint capture. */
export function hasRunningWorkspaceJobs(
  roots: string[],
  ownerSessions: string[],
) {
  return [...jobs.values()].some((job) => {
    if (job.status !== 'running' || ownerSessions.includes(job.sessionId))
      return false
    return roots.some((root) =>
      job.roots?.some(
        (other) => !isOutside(root, other) || !isOutside(other, root),
      ),
    )
  })
}
