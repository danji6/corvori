import type { EvaluationResult } from '@cv/core/interpreter/request'
import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'

import { withAgentFiles } from '../agent-files/access'
import { evaluateInWorker } from './pool'
import { authoredEvaluationSchema, evaluationOperationSchema } from './schemas'
import { runEvaluationShell } from './shell'

const bootId = randomUUID()
const leaseMs = 90_000
const operations = new Map<string, Operation>()

type Operation = {
  abort: AbortController
  lease?: ReturnType<typeof setTimeout>
  settled?: Promise<void>
  result?: EvaluationResult
  error?: string
  waiting?: { call: number; authorize: (allowed: boolean) => void }
  calls: number
}

const startSchema = evaluationOperationSchema.extend({
  input: authoredEvaluationSchema,
})

const statusSchema = evaluationOperationSchema.extend({
  grant: z.object({ call: z.number().int(), allowed: z.boolean() }).optional(),
})

export const evaluationRoutes = new Hono()
  .post('/instance', (c) => c.json({ bootId }))
  .post('/start', async (c) => {
    const req = startSchema.parse(await c.req.json())
    if (req.bootId !== bootId) return c.json({ state: 'lost' })
    const existing = operations.get(req.id)
    if (existing) return c.json(status(existing))
    const operation: Operation = { abort: new AbortController(), calls: 0 }
    operations.set(req.id, operation)
    renew(req.id, operation)
    operation.settled = evaluate(req.input, operation)
    return c.json(status(operation))
  })
  .post('/status', async (c) => {
    const req = statusSchema.parse(await c.req.json())
    const operation = req.bootId === bootId ? operations.get(req.id) : undefined
    if (!operation) return c.json({ state: 'lost' })
    if (req.grant && operation.waiting?.call === req.grant.call) {
      operation.waiting.authorize(req.grant.allowed)
    }
    if (!operation.abort.signal.aborted) renew(req.id, operation)
    return c.json(status(operation))
  })
  .post('/cancel', async (c) => {
    const req = evaluationOperationSchema.parse(await c.req.json())
    if (req.bootId !== bootId) return c.json({ ok: true })
    const operation = operations.get(req.id) ?? {
      abort: new AbortController(),
      calls: 0,
    }
    operations.set(req.id, operation)
    cancel(operation)
    await operation.settled
    expire(req.id, operation)
    return c.json({ ok: true })
  })
  .post('/acknowledge', async (c) => {
    const req = evaluationOperationSchema.parse(await c.req.json())
    const operation = req.bootId === bootId ? operations.get(req.id) : undefined
    if (operation && (operation.error || operation.result)) {
      operation.result = undefined
      operation.error = 'Prompt evaluation has already been collected'
      expire(req.id, operation)
    }
    return c.json({ ok: true })
  })

function status(operation: Operation) {
  if (operation.error) return { state: 'failed', error: operation.error }
  if (operation.result) return { state: 'complete', result: operation.result }
  return { state: 'running', call: operation.waiting?.call }
}

async function evaluate(
  {
    shell,
    shellWorkspaceRequired,
    ...request
  }: z.infer<typeof authoredEvaluationSchema>,
  operation: Operation,
) {
  const signal = operation.abort.signal
  try {
    const result = await withAgentFiles(request.authorizedAgentId, () =>
      evaluateInWorker(
        { ...request, authored: true },
        {
          signal,
          shell:
            (shell || shellWorkspaceRequired) &&
            (async (args, commandSignal) => {
              if (!(await authorizeCall(operation, commandSignal)))
                return 'Error: not an admin'
              if (!shell)
                return 'Error: a workspace is required to run shell commands'
              return runEvaluationShell(
                shell,
                args,
                commandSignal,
                request.kind,
              )
            }),
        },
      ),
    )
    if (!signal.aborted) operation.result = result
  } catch (error) {
    operation.error ??=
      error instanceof Error ? error.message : 'Prompt evaluation failed'
  }
}

function authorizeCall(operation: Operation, signal: AbortSignal) {
  if (signal.aborted) return false
  return new Promise<boolean>((resolve) => {
    const authorize = (allowed: boolean) => {
      delete operation.waiting
      signal.removeEventListener('abort', cancelCall)
      resolve(allowed)
    }
    const cancelCall = () => authorize(false)
    operation.waiting = { call: ++operation.calls, authorize }
    signal.addEventListener('abort', cancelCall, { once: true })
  })
}

function renew(id: string, operation: Operation) {
  clearTimeout(operation.lease)
  operation.lease = setTimeout(() => {
    cancel(operation)
    expire(id, operation)
  }, leaseMs)
  operation.lease.unref()
}

function expire(id: string, operation: Operation) {
  clearTimeout(operation.lease)
  operation.lease = setTimeout(() => operations.delete(id), 15 * 60_000)
  operation.lease.unref()
}

function cancel(operation: Operation) {
  clearTimeout(operation.lease)
  operation.result = undefined
  operation.error = 'Prompt evaluation stopped or its lease expired'
  operation.abort.abort()
}

export async function drainEvaluations() {
  const active = [...operations.values()]
  for (const operation of active) cancel(operation)
  await Promise.allSettled(active.map((operation) => operation.settled))
}
