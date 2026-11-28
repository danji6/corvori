import type { ShellOutputSnapshot } from '@cv/core/shell/job-protocol'
import {
  SHELL_PAGE_CHARS,
  SHELL_TERM_TAIL_CHARS,
  plainOutputPage,
} from '@cv/core/shell/output-page'
import type { ShellToolOutput } from '@cv/core/types/tools'

import { postSidecar } from '../sidecar'
import type {
  ShellJobContext,
  ShellJobOptions,
  ShellReadPosition,
} from './shellContracts'
import { watchJob } from './shellWatch'

export const DEFAULT_SHELL_WAIT_SECONDS = 60

export function shellWaitSeconds(seconds = DEFAULT_SHELL_WAIT_SECONDS) {
  return Math.min(600, Math.max(0, seconds))
}

/** Waits for exit or the original deadline, irrespective of output volume. */
export async function* waitForShell(
  context: ShellJobContext,
  jobId: string,
  waitUntil: number,
  options: ShellJobOptions,
  launch: boolean,
): AsyncGenerator<ShellToolOutput> {
  const post = options.post ?? postSidecar

  const windowDeadline =
    options.windowDeadline !== undefined && options.windowDeadline < waitUntil
      ? options.windowDeadline
      : undefined

  const watch = watchJob(context, jobId, {
    ...options,
    post,
    waitDeadline: waitUntil,
    windowDeadline,
    detachOnBackground: launch,
    killOnAbort: launch,
  })

  yield {
    jobId,
    status: 'running',
    exitCode: null,
    text: '',
    term: '',
    termOffset: 0,
    waitUntil,
  }

  let result: ShellToolOutput | undefined
  for await (const part of watch) {
    result = part
    if (part.status === 'running') yield { ...part, waitUntil }
  }
  if (!result) {
    throw new Error('Shell wait produced no result')
  }
  if (options.abortSignal?.aborted || result.status === 'running') {
    return
  }
  if (result.status === 'lost') {
    yield result
    return
  }

  if (launch && result.status === 'background') {
    await post('/shell/background', { sessionId: context.sessionId, jobId })
  }

  const snapshot = await post<ShellOutputSnapshot>('/shell/poll', {
    sessionId: context.sessionId,
    jobId,
    offset: 0,
    limit: 0,
    tailChars: SHELL_TERM_TAIL_CHARS,
  })

  yield timedResult(jobId, snapshot, options.readPosition)
}

function timedResult(
  jobId: string,
  snapshot: ShellOutputSnapshot,
  position?: ShellReadPosition,
): ShellToolOutput {
  const { term, termOffset, bufferEnd } = snapshot
  const firstUnread = Math.min(position?.offset ?? 0, bufferEnd)
  let end = bufferEnd
  let start = Math.max(firstUnread, termOffset, end - SHELL_PAGE_CHARS)

  // Select the most recent contiguous gap in delivered output.
  for (const span of [...(position?.covered ?? [])].reverse()) {
    if (span.start >= end) continue
    if (span.end >= end) {
      end = Math.max(firstUnread, span.start)
      start = Math.max(firstUnread, termOffset, end - SHELL_PAGE_CHARS)
      continue
    }
    start = Math.max(start, span.end)
    break
  }

  start = Math.min(start, end)
  const from = Math.max(0, start - termOffset)
  const first = term.charCodeAt(from)
  if (start < end && first >= 0xdc00 && first <= 0xdfff) start++
  const prefix = term.slice(0, Math.max(0, start - termOffset))
  const initial = plainOutputPage(
    prefix,
    termOffset === position?.offset ? position.ansiState : 'text',
  ).state
  const page =
    end > start
      ? plainOutputPage(
          term.slice(start - termOffset, end - termOffset),
          initial,
        )
      : { text: '', state: initial }

  return {
    jobId,
    status: snapshot.status === 'running' ? 'background' : snapshot.status,
    exitCode: snapshot.exitCode,
    ...(snapshot.sandboxDenials && { sandboxDenials: snapshot.sandboxDenials }),
    ...(snapshot.retryCwd && { retryCwd: snapshot.retryCwd }),
    text: page.text,
    term,
    termOffset,
    waiting: snapshot.waiting,
    range: {
      requestedOffset: start,
      startOffset: start,
      nextOffset: end,
      bufferEnd,
      hasMore: start > firstUnread,
      replay: false,
      unavailable: [],
      ...(start > firstUnread && {
        skipped: { start: firstUnread, end: start },
      }),
      ansiState: page.state,
    },
  }
}
