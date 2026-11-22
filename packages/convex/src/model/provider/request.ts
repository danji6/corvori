import type { FetchFunction } from '@ai-sdk/provider-utils'
import { parseModelExtraParameters } from '@cv/core/model-parameters'
import { normalizeReasoningEffort } from '@cv/core/model-reasoning'
import { parseProviderExtraHeaders } from '@cv/core/provider-headers'
import type { ModelReasoning, ReasoningEffort } from '@cv/core/types'

import { omitLargeStrings } from '../stream/transformers'
import { providerReasoningField, resolveModelReasoning } from './known'
import {
  type ProviderPlaceholderResolvers,
  type ProviderPlaceholderValues,
  type ResolveProviderPlaceholder,
  expandProviderParameters,
  expandProviderTemplate,
  findProviderPlaceholders,
  requestPlaceholderResolver,
  resolveProviderPlaceholders,
} from './placeholders'
import { adaptReasoningResponse } from './response'

/** Applies transport-specific options and merges the expanded model parameters. */
export type ProviderRequestTransform = (
  body: Record<string, unknown>,
  parameters: Record<string, unknown>,
  resolvePlaceholder: ResolveProviderPlaceholder,
) => Promise<Record<string, unknown>>

type RequestAdapterOptions = {
  providerId: string
  transformRequest?: ProviderRequestTransform
  reasoning?: ModelReasoning
  reasoningEffort?: ReasoningEffort
  extraParameters?: string
  extraHeaders?: string
  placeholderResolvers?: ProviderPlaceholderResolvers
  fetch?: FetchFunction
  onRequest?: (body: string) => void | Promise<void>
}

export function createProviderFetch({
  providerId,
  transformRequest,
  reasoning,
  reasoningEffort,
  extraParameters,
  extraHeaders,
  placeholderResolvers,
  fetch: baseFetch = globalThis.fetch,
  onRequest,
}: RequestAdapterOptions): FetchFunction {
  const resolvedReasoning = resolveModelReasoning(providerId, reasoning)
  const effort = normalizeReasoningEffort(reasoningEffort, resolvedReasoning)
  const extras = parseModelExtraParameters(extraParameters)
  const headers = parseProviderExtraHeaders(extraHeaders)
  const headerPlaceholders = findProviderPlaceholders(headers)
  const parameterPlaceholders = findProviderPlaceholders(extras)
  const bodyRequestPlaceholders = new Set([
    ...headerPlaceholders,
    ...parameterPlaceholders,
  ])

  const adapted = async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = parseRequestBody(init?.body)
    const resolvePlaceholder = requestPlaceholderResolver(placeholderResolvers)
    const names = body ? bodyRequestPlaceholders : headerPlaceholders
    const values = names.size
      ? await resolveProviderPlaceholders(names, resolvePlaceholder)
      : undefined
    const requestInit = mergeRequestHeaders(init, headers, values)
    if (!body) return adaptResponse(await baseFetch(input, requestInit))

    const reasoningPatch = reasoningBodyPatch(
      providerId,
      resolvedReasoning,
      effort,
      body,
    )
    const parameters =
      values && parameterPlaceholders.size
        ? expandProviderParameters(extras, values)
        : extras
    const combined = { ...body, ...reasoningPatch }
    const merged = transformRequest
      ? await transformRequest(combined, parameters, resolvePlaceholder)
      : { ...combined, ...parameters }
    if (onRequest) {
      await onRequest(JSON.stringify(omitLargeStrings(merged), null, 2))
    }

    return adaptResponse(
      await baseFetch(input, {
        ...requestInit,
        body: JSON.stringify(merged),
      }),
      merged.stream === true,
    )
  }

  const reasoningField = providerReasoningField(providerId)
  const adaptResponse = (response: Response, stream?: boolean) =>
    reasoningField
      ? adaptReasoningResponse(response, reasoningField, stream)
      : Promise.resolve(response)

  return adapted as FetchFunction
}

function parseRequestBody(body: RequestInit['body']) {
  if (typeof body !== 'string') return
  try {
    const parsed: unknown = JSON.parse(body)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // Forward non-JSON requests with their original bodies.
  }
}

function mergeRequestHeaders(
  init: RequestInit | undefined,
  extraHeaders: Record<string, string>,
  placeholders?: ProviderPlaceholderValues,
): RequestInit | undefined {
  if (Object.keys(extraHeaders).length === 0) return init
  const headers = new Headers(init?.headers)
  for (const [name, value] of Object.entries(extraHeaders)) {
    const expanded = placeholders
      ? expandProviderTemplate(value, placeholders)
      : value
    headers.set(name, expanded)
  }
  return { ...init, headers }
}

function reasoningBodyPatch(
  providerId: string,
  reasoning: ModelReasoning,
  effort: ReasoningEffort,
  body: Record<string, unknown>,
): Record<string, unknown> {
  if (reasoning.type === 'binary') {
    return { [reasoning.parameter]: effort !== 'none' }
  }
  if (reasoning.type !== 'effort') {
    return {}
  }
  if (providerId === 'ollama') {
    if (effort === 'auto') return { think: true }
    return { think: effort === 'none' ? false : effort }
  }
  if (effort !== 'max') {
    return {}
  }

  switch (providerId) {
    case 'anthropic':
      return { output_config: { effort } }
    case 'openrouter':
      return { reasoning: { effort } }
    default:
      if ('input' in body) {
        const existing =
          body.reasoning && typeof body.reasoning === 'object'
            ? body.reasoning
            : {}
        return { reasoning: { ...existing, effort } }
      }
      return { reasoning_effort: effort }
  }
}
