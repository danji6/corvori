import { EVAL_LIMITS } from '@cv/core/interpreter/limits'
import type {
  EvaluationReply,
  EvaluationRequest,
  EvaluationResult,
} from '@cv/core/interpreter/request'
import { Worker } from 'node:worker_threads'

import { type ShellCall, respondToShell } from './shell-bridge'

export class EvaluationBusyError extends Error {
  constructor() {
    super('Dynamic evaluation is busy; please retry')
  }
}

type WorkerRequest = EvaluationRequest & {
  authorizedAgentDir?: string
  authorizedWorkDir?: string
  authorizedWorkDirs?: string[]
}

type WorkerOptions = {
  signal?: AbortSignal
  shell?: (args: string[], signal: AbortSignal) => Promise<string>
}

type Slot = { active: number; queue: Array<() => void> }

const ordinary: Slot = { active: 0, queue: [] }
const authored: Slot = { active: 0, queue: [] }

/** Keeps indefinitely waiting authored commands out of the ordinary worker pool. */
export async function evaluateInWorker(
  request: WorkerRequest,
  options: WorkerOptions = {},
): Promise<EvaluationResult> {
  const slot = options.shell ? authored : ordinary
  await acquire(slot, options.signal)
  try {
    options.signal?.throwIfAborted()
    return await runWorker(request, options)
  } finally {
    const next = slot.queue.shift()
    if (next) next()
    else slot.active--
  }
}

async function acquire(slot: Slot, signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason
  if (slot.active < EVAL_LIMITS.concurrency) {
    slot.active++
    return
  }
  if (slot.queue.length >= EVAL_LIMITS.queueLength)
    throw new EvaluationBusyError()
  await new Promise<void>((resolve, reject) => {
    const ready = () => {
      signal?.removeEventListener('abort', cancel)
      resolve()
    }
    const cancel = () => {
      const index = slot.queue.indexOf(ready)
      if (index !== -1) slot.queue.splice(index, 1)
      reject(signal?.reason)
    }
    slot.queue.push(ready)
    signal?.addEventListener('abort', cancel, { once: true })
  })
}

function runWorker(request: WorkerRequest, options: WorkerOptions) {
  return new Promise<EvaluationResult>((resolve, reject) => {
    const worker = new Worker(new URL('./worker.js', import.meta.url), {
      workerData: { ...request, shellEnabled: !!options.shell },
      env: {},
      resourceLimits: { maxOldGenerationSizeMb: 128, stackSizeMb: 4 },
    })

    const commandAbort = new AbortController()
    let settled = false
    let command: Promise<void> | undefined
    let remaining = EVAL_LIMITS.deadlineMs as number
    let resumedAt = Date.now()
    const onTimeout = () => fail('Dynamic evaluation timed out')
    let timer = setTimeout(onTimeout, remaining)

    function finish(reply: EvaluationReply) {
      if (settled) return
      settled = true
      commandAbort.abort()
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', cancel)
      void Promise.allSettled([worker.terminate(), command]).then(() => {
        if (reply.ok) resolve(reply.result)
        else reject(new Error(reply.error))
      })
    }

    const fail = (error: string) => finish({ ok: false, error })
    const cancel = () => fail('Prompt evaluation stopped')

    async function runShell(call: ShellCall) {
      const output = await options
        .shell?.(call.args, commandAbort.signal)
        .catch(() => 'Error: could not run shell command')
      if (settled) return
      resumedAt = Date.now()
      timer = setTimeout(onTimeout, Math.max(0, remaining))
      respondToShell(call, output ?? 'Error: not an admin')
    }

    options.signal?.addEventListener('abort', cancel, { once: true })

    worker.on('message', (reply: EvaluationReply | ShellCall) => {
      if (settled) return
      if (!('type' in reply)) return finish(reply)
      clearTimeout(timer)
      remaining -= Date.now() - resumedAt
      command = runShell(reply)
    })
    worker.once('error', () => fail('Dynamic evaluation worker failed'))
    worker.once('exit', () => fail('Dynamic evaluation worker stopped'))
  })
}
