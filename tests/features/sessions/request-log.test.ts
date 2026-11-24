import { buildRequestLogBody } from '@/lib/request-log'
import type { CacheDiagnostic } from '@cv/convex/validators/providerRequests'
import { expect, test } from 'bun:test'

test.each(['messages', 'input'])(
  'puts request details before %s and the response at the end',
  (messageField) => {
    const messages = [
      { role: 'user', content: 'Question' },
      { role: 'assistant', content: 'Answer' },
    ]
    const request = {
      model: 'fixture-model',
      [messageField]: messages,
      tools: [{ name: 'lookup' }],
      stream: true,
    }
    const response = { parts: [{ type: 'text', text: 'Latest answer' }] }
    const cacheDiagnostics = [{ id: 'fixture-request' }] as CacheDiagnostic[]
    const log = JSON.parse(
      buildRequestLogBody(
        JSON.stringify(request),
        JSON.stringify(response),
        cacheDiagnostics,
      )!,
    )

    expect(Object.keys(log)).toEqual([
      'cacheDiagnostics',
      'request',
      'response',
    ])
    expect(Object.keys(log.request)).toEqual([
      'model',
      'tools',
      'stream',
      messageField,
    ])
    expect(log).toEqual({ cacheDiagnostics, request, response })
  },
)
