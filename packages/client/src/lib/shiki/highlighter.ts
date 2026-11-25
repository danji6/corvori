import { ShikiWorker, type ShikiWorkerApi } from '@/workers'
import type { WorkerApi } from '@/workers'
import { releaseProxy } from 'comlink'

import { isClient } from '../utils'
import { runDiffHighlighter, runHighlighter } from './core'
import { StringCache } from './string-cache'

let worker: WorkerApi<ShikiWorkerApi> | null = null

function getWorker(): WorkerApi<ShikiWorkerApi> {
  if (!worker) worker = ShikiWorker()
  return worker
}

const MAX_CACHE_ENTRIES = 500
const MAX_CACHE_BYTES = 16 * 1024 * 1024
const cache = new StringCache(MAX_CACHE_ENTRIES, MAX_CACHE_BYTES)
const inFlight = new Map<string, Promise<string>>()
let workerQueue: Promise<unknown> = Promise.resolve()

/** Synchronously returns a previously highlighted result, if any. */
export function getCachedHighlight(
  code: string,
  lang?: string,
  diff: boolean = false,
): string | null {
  return cache.get(cacheKey(code, lang, diff)) ?? null
}

/** Main highlighter function. Attempts to use a worker if possible. */
export async function highlight(code: string, lang: string = 'typescript') {
  const key = cacheKey(code, lang, false)
  const cached = cache.get(key)
  if (cached !== undefined) return cached

  return runOnce(key, () =>
    isClient
      ? getWorker().api.highlight(code, lang)
      : runHighlighter(code, lang),
  )
}

export async function highlightDiff(diff: string, lang?: string) {
  const key = cacheKey(diff, lang, true)
  const cached = cache.get(key)
  if (cached !== undefined) return cached

  return runOnce(key, () =>
    isClient
      ? getWorker().api.highlightDiff(diff, lang)
      : runDiffHighlighter(diff, lang),
  )
}

/** Opens a worker endpoint owned by a single text preview. */
export function openTextPreviewHighlighter(
  language: string,
  signal: AbortSignal,
) {
  let endpoint:
    ReturnType<WorkerApi<ShikiWorkerApi>['api']['openTextPreview']> | undefined
  let pending: Promise<string[]> | undefined

  signal.addEventListener(
    'abort',
    () => {
      void Promise.allSettled([endpoint, pending]).then(([result]) => {
        if (result.status === 'fulfilled') result.value?.[releaseProxy]()
      })
    },
    { once: true },
  )

  return (complete: string | null, tail: string | null) => {
    pending = schedule(async () => {
      signal.throwIfAborted()
      endpoint ??= getWorker().api.openTextPreview(language)
      const highlight = await endpoint
      signal.throwIfAborted()
      return highlight(complete, tail)
    })
    return pending
  }
}

function cacheKey(code: string, lang: string | undefined, diff: boolean) {
  return `${diff ? 'd' : 'c'}\0${lang ?? ''}\0${code}`
}

function runOnce(key: string, run: () => Promise<string>): Promise<string> {
  const pending = inFlight.get(key)
  if (pending) return pending

  const promise = schedule(run)
    .then((result) => {
      cache.set(key, result)
      return result
    })
    .finally(() => {
      inFlight.delete(key)
    })

  inFlight.set(key, promise)
  return promise
}

function schedule<T>(run: () => Promise<T>) {
  if (!isClient) return run()

  // A single worker cannot execute highlights concurrently. Serialize calls
  // here so the browser doesn't retain a native structured clone buffer for
  // every code block while those calls wait in the worker's message queue.
  const result = workerQueue.then(run, run)
  workerQueue = result.catch(() => undefined)
  return result
}
