'use node'

import { STREAM_PATCH_INTERVAL_MS } from '@cv/core/const'
import type { UIMessage } from 'ai'

type Parts = UIMessage['parts']

/** Serializes partial writes and flushes the latest snapshot during silence. */
export function createStreamPatcher(
  write: (parts: Parts) => Promise<boolean>,
  controller: AbortController,
) {
  let pending: Parts | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let inFlight: Promise<void> | undefined
  let lastStarted = -Infinity
  let failure: { error: unknown } | undefined
  let rejected = false

  function remaining() {
    return STREAM_PATCH_INTERVAL_MS - (performance.now() - lastStarted)
  }

  function clearTimer() {
    clearTimeout(timer)
    timer = undefined
  }

  function schedule() {
    if (!pending || timer || inFlight || controller.signal.aborted) return
    timer = setTimeout(start, Math.max(0, Math.ceil(remaining())))
  }

  function start() {
    clearTimer()
    const parts = pending
    if (!parts || controller.signal.aborted) return
    pending = undefined
    lastStarted = performance.now()
    inFlight = Promise.resolve()
      .then(() => write(parts))
      .then((applied) => {
        if (applied) return
        rejected = true
        controller.abort()
      })
      .catch((error: unknown) => {
        failure = { error }
        controller.abort(error)
      })
      .finally(() => {
        inFlight = undefined
        schedule()
      })
    return inFlight
  }

  return {
    update(parts: Parts, immediate: boolean) {
      if (controller.signal.aborted) return
      pending = parts
      if (immediate) return inFlight ? inFlight.then(start) : start()
      if (!inFlight && remaining() <= 0) return start()
      schedule()
    },
    /** The caller persists the terminal snapshot after any partial write. */
    async close() {
      pending = undefined
      clearTimer()
      await inFlight
    },
    get failure() {
      return failure
    },
    get rejected() {
      return rejected
    },
  }
}
