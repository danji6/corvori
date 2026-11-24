import type { CacheDiagnostic } from '@cv/convex/validators/providerRequests'

export function buildRequestLogBody(
  requestBody?: string,
  responseBody?: string,
  cacheDiagnostics?: CacheDiagnostic[],
) {
  if (!requestBody && !responseBody && !cacheDiagnostics?.length) return null

  return JSON.stringify(
    {
      ...(cacheDiagnostics?.length ? { cacheDiagnostics } : {}),
      request: requestBody
        ? orderRequestFields(requestBody)
        : 'Not captured yet.',
      response: responseBody
        ? parseJsonBody(responseBody)
        : 'Awaiting response…',
    },
    null,
    2,
  )
}

function orderRequestFields(body: string) {
  const request = parseJsonBody(body)
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    return request
  }

  // Chat Completions uses messages, while Responses uses input.
  const { messages, input, ...requestData } = request as Record<string, unknown>
  return { ...requestData, messages, input }
}

function parseJsonBody(body: string): unknown {
  try {
    return JSON.parse(body)
  } catch {
    return body
  }
}
