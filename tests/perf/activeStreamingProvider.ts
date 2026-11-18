import { strict as assert } from 'node:assert'
import { type ServerResponse, createServer } from 'node:http'

import { deadline } from './clients'

export const now = () => performance.timeOrigin + performance.now()

export const workloads = ['quiet-stop', 'slow', 'fast', 'fast-stop'] as const
export type Workload = (typeof workloads)[number]

type End = { at: number; kind: 'finished' | 'disconnected' }
type Chunk = { at: number; text: string }

export function streamScript(
  account: number,
  marker: string,
  workload: Workload,
) {
  const started = Promise.withResolvers<number>()
  const ended = Promise.withResolvers<End>()
  const chunks: Chunk[] = []
  let requestedAt = 0
  return {
    account,
    marker,
    workload,
    chunks,
    get requestedAt() {
      return requestedAt
    },
    start(at: number) {
      requestedAt = at
      started.resolve(at)
    },
    end: ended.resolve,
    started: () =>
      deadline(started.promise, `provider request for ${marker}`, 30_000),
    ended: () =>
      deadline(ended.promise, `provider termination for ${marker}`, 30_000),
  }
}

export type Script = ReturnType<typeof streamScript>

export async function startProvider() {
  const scheduled = new Map<number, Script>()
  const errors: string[] = []
  const server = createServer(async (request, response) => {
    const at = now()
    try {
      const match = request.url?.match(/^\/(\d+)\/chat\/completions$/)
      assert.ok(
        request.method === 'POST' && match,
        'Unexpected provider endpoint',
      )
      const account = Number(match[1])
      const script = scheduled.get(account)
      assert.ok(script, `Unexpected provider request for account ${account}`)
      scheduled.delete(account)
      const body: Buffer[] = []
      for await (const chunk of request) body.push(chunk as Buffer)
      assert.ok(
        Buffer.concat(body).toString().includes(script.marker),
        `Wrong provider prompt for ${script.marker}`,
      )
      respond(response, script, at)
    } catch (error) {
      errors.push(String(error))
      response.writeHead(500).end()
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return {
    url: `http://127.0.0.1:${address.port}`,
    schedule(script: Script) {
      assert.ok(
        !scheduled.has(script.account),
        'Provider script already scheduled',
      )
      scheduled.set(script.account, script)
    },
    verify() {
      assert.deepEqual(errors, [])
      assert.equal(scheduled.size, 0, 'Provider scripts were left unrequested')
    },
    close() {
      server.close()
      server.closeAllConnections()
    },
  }
}

function frame(marker: string, text: string | null, index: number) {
  return `data: ${JSON.stringify({
    id: marker,
    object: 'chat.completion.chunk',
    created: 0,
    model: 'perf-stream-model',
    choices: [
      {
        index: 0,
        delta:
          text === null
            ? {}
            : { ...(index === 0 && { role: 'assistant' }), content: text },
        finish_reason: text === null ? 'stop' : null,
      },
    ],
    ...(text === null && {
      usage: {
        prompt_tokens: 8,
        completion_tokens: index,
        total_tokens: 8 + index,
      },
    }),
  })}\n\n`
}

function respond(
  response: ServerResponse,
  script: Script,
  requestedAt: number,
) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' })
  response.flushHeaders()
  script.start(requestedAt)
  let timer: ReturnType<typeof setTimeout> | undefined
  response.once('close', () => {
    clearTimeout(timer)
    script.end({ at: now(), kind: 'disconnected' })
  })
  if (script.workload === 'quiet-stop') return

  const interval = script.workload === 'slow' ? 400 : 10
  const count = 4000 / interval
  const start = now()
  const tick = () => {
    const index = script.chunks.length
    const text = `${index ? ' ' : ''}${script.marker}-${String(index).padStart(3, '0')}.`
    script.chunks.push({ at: now(), text })
    response.write(frame(script.marker, text, index))
    if (script.chunks.length === count) {
      script.end({ at: now(), kind: 'finished' })
      response.end(frame(script.marker, null, count) + 'data: [DONE]\n\n')
      return
    }
    timer = setTimeout(
      tick,
      Math.max(0, start + (index + 2) * interval - now()),
    )
  }
  timer = setTimeout(tick, interval)
}
