import type { ModelMessage } from '@ai-sdk/provider-utils'

const ANTHROPIC_CACHE_CONTROL = { type: 'ephemeral' } as const

const ANTHROPIC_TRAILING_BREAKPOINTS = 2

export type CacheableRequest = {
  systemPrompt: string | undefined
  messages: ModelMessage[]
}

/** Adds prompt cache breakpoints. Currently Anthropic only. */
export function applyPromptCaching(
  request: CacheableRequest,
  providerId: string | undefined,
): CacheableRequest {
  if (providerId !== 'anthropic') return request

  const messages = request.messages.map((message, index) =>
    request.messages.length - index <= ANTHROPIC_TRAILING_BREAKPOINTS
      ? withCacheControl(message)
      : message,
  )

  if (request.systemPrompt) {
    messages.unshift(
      withCacheControl({ role: 'system', content: request.systemPrompt }),
    )
    return { systemPrompt: undefined, messages }
  }

  return { systemPrompt: undefined, messages }
}

/** Appends instructions after placing the same cache breakpoints as chat. */
export function appendOperationMessages(
  prefix: CacheableRequest,
  trailing: ModelMessage[],
  providerId: string | undefined,
): CacheableRequest {
  if (trailing.length === 0) return prefix

  const suffix =
    providerId === 'anthropic'
      ? anthropicOperationMessages(prefix.messages, trailing)
      : trailing
  return { ...prefix, messages: [...prefix.messages, ...suffix] }
}

function anthropicOperationMessages(
  prefix: ModelMessage[],
  trailing: ModelMessage[],
) {
  // Anthropic hoists the first system block, even if it follows history.
  if (!prefix.some((message) => message.role === 'system'))
    return trailing.map(asUserInstruction)

  if (prefix.some((message) => message.role !== 'system')) return trailing

  // Leading operation system messages would extend the prefix's system block.
  const endOfSystem = trailing.findIndex((message) => message.role !== 'system')
  if (endOfSystem === -1) return trailing.map(asUserInstruction)
  return [
    ...trailing.slice(0, endOfSystem).map(asUserInstruction),
    ...trailing.slice(endOfSystem),
  ]
}

function asUserInstruction(message: ModelMessage): ModelMessage {
  return message.role === 'system' ? { ...message, role: 'user' } : message
}

function withCacheControl(message: ModelMessage): ModelMessage {
  return {
    ...message,
    providerOptions: {
      ...message.providerOptions,
      anthropic: {
        ...message.providerOptions?.anthropic,
        cacheControl: ANTHROPIC_CACHE_CONTROL,
      },
    },
  } as ModelMessage
}
