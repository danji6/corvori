import {
  MAX_MESSAGE_PART_BYTES,
  MAX_PROMPT_CONTENT_CHARS,
  MAX_SEGMENT_BYTES,
} from '../limits'
import { type EvalHelpers, render } from './evaluate'
import { createSandbox, initializeEvaluator } from './sandbox'
import { createVariableStore, environmentCapError } from './store'
import type { EvalContext, JsonValue } from './types'

/** JSON-only boundary shared by browser and sidecar workers. */
export type EvaluationRequest = {
  texts: string[]
  context: EvalContext
  environment?: Record<string, JsonValue>
  kind: 'prompt' | 'message'
  authored?: boolean
}

export type EvaluationResult = {
  texts: string[]
  environment: Record<string, JsonValue>
  dirty: boolean
  writes?: Record<string, JsonValue>
}

export type EvaluationReply =
  { ok: true; result: EvaluationResult } | { ok: false; error: string }

/** Evaluates one atomic batch with shared variables and a fresh guest runtime. */
export async function evaluateRequest(
  request: EvaluationRequest,
  helpers: EvalHelpers = {},
): Promise<EvaluationResult> {
  await initializeEvaluator()

  const environment = structuredClone(request.environment ?? {})
  const capError = environmentCapError(environment)
  if (capError) throw new Error(capError)
  const store = createVariableStore(environment)
  const written = new Set<string>()
  const set = store.set
  store.set = (key, value) => {
    set(key, value)
    written.add(key)
  }
  const sandbox = createSandbox(request.context, store, helpers)

  try {
    const texts = request.texts.map((text) => {
      checkText(text, request.kind)
      const result = render(text, sandbox.run, sandbox.usedShell)
      if (request.authored && exceedsTextLimit(result, request.kind))
        return 'Error: evaluated output exceeds the prompt size limit'
      checkText(result, request.kind)
      return result
    })
    if (
      request.kind === 'message' &&
      new TextEncoder().encode(JSON.stringify(texts)).length > MAX_SEGMENT_BYTES
    ) {
      throw new Error('Evaluated message exceeds the segment limit')
    }
    const result = {
      texts,
      environment: store.toRecord(),
      dirty: store.isDirty(),
    }
    if (!request.authored) return result
    return {
      ...result,
      writes: Object.fromEntries(
        [...written].map((key) => [key, result.environment[key]]),
      ),
    }
  } finally {
    sandbox.dispose()
  }
}

function exceedsTextLimit(text: string, kind: EvaluationRequest['kind']) {
  const size =
    kind === 'prompt' ? text.length : new TextEncoder().encode(text).length
  const limit =
    kind === 'prompt' ? MAX_PROMPT_CONTENT_CHARS : MAX_MESSAGE_PART_BYTES
  return size > limit
}

function checkText(text: string, kind: EvaluationRequest['kind']) {
  if (exceedsTextLimit(text, kind)) {
    throw new Error('Dynamic content exceeds its size limit')
  }
}
