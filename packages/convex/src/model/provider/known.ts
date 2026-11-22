import {
  DEFAULT_BINARY_REASONING_PARAMETER,
  defaultModelReasoning,
  normalizeBinaryReasoningParameter,
} from '@cv/core/model-reasoning'
import { OPENAI_COMPATIBLE_PROVIDER_KEY } from '@cv/core/provider-registry'
import type { ModelReasoning } from '@cv/core/types'

import { error } from '../../errors'

export type ChatCompletionsTransport = {
  defaultBaseURL?: string
  /** Non-standard field used for reasoning in chat completion responses. */
  reasoningField?: string
}

export type ProviderDefinition = {
  label: string
  requiresBaseURL?: boolean
  defaultReasoning: ModelReasoning
  binaryReasoningParameter?: string
  /** Declares that the endpoint accepts OpenAI-style chat completion bodies. */
  chatCompletions?: ChatCompletionsTransport
}

const definitions = {
  anthropic: {
    label: 'Anthropic',
    defaultReasoning: defaultModelReasoning(),
  },
  alibaba: {
    label: 'Alibaba',
    defaultReasoning: defaultModelReasoning(),
    chatCompletions: {
      defaultBaseURL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    },
  },
  deepseek: {
    label: 'DeepSeek',
    defaultReasoning: defaultModelReasoning(),
    chatCompletions: { defaultBaseURL: 'https://api.deepseek.com' },
  },
  mistral: {
    label: 'Mistral',
    defaultReasoning: defaultModelReasoning(),
    chatCompletions: { defaultBaseURL: 'https://api.mistral.ai/v1' },
  },
  moonshotai: {
    label: 'MoonshotAI',
    defaultReasoning: defaultModelReasoning(),
  },
  ollama: {
    label: 'Ollama',
    defaultReasoning: defaultModelReasoning(),
    binaryReasoningParameter: 'think',
  },
  openai: {
    label: 'OpenAI',
    defaultReasoning: defaultModelReasoning(),
    chatCompletions: { defaultBaseURL: 'https://api.openai.com/v1' },
  },
  openrouter: {
    label: 'OpenRouter',
    defaultReasoning: defaultModelReasoning(),
    chatCompletions: {
      defaultBaseURL: 'https://openrouter.ai/api/v1',
    },
  },
  qwen: {
    label: 'QwenCloud',
    requiresBaseURL: true,
    defaultReasoning: {
      type: 'binary',
      parameter: DEFAULT_BINARY_REASONING_PARAMETER,
    },
    binaryReasoningParameter: DEFAULT_BINARY_REASONING_PARAMETER,
    chatCompletions: { reasoningField: 'reasoning_content' },
  },
  [OPENAI_COMPATIBLE_PROVIDER_KEY]: {
    label: 'Other…',
    requiresBaseURL: true,
    defaultReasoning: defaultModelReasoning(),
    chatCompletions: {},
  },
} satisfies Record<string, ProviderDefinition>

export type ProviderKey = keyof typeof definitions

export function isProviderKey(key: string): key is ProviderKey {
  return Object.hasOwn(definitions, key)
}

export function requireProviderKey(key: string): ProviderKey {
  if (isProviderKey(key)) return key
  error(key.trim() ? 'Unsupported provider type' : 'Provider is required')
}

export function listProviderIds() {
  const { [OPENAI_COMPATIBLE_PROVIDER_KEY]: compatible, ...builtIns } =
    definitions
  const providers = Object.entries<ProviderDefinition>(builtIns)
  providers.sort(([, a], [, b]) => a.label.localeCompare(b.label))
  providers.push([OPENAI_COMPATIBLE_PROVIDER_KEY, compatible])
  return providers.map(([value, definition]) => ({
    value,
    label: definition.label,
    requiresBaseURL: definition.requiresBaseURL ?? false,
    defaultReasoning: definition.defaultReasoning,
    binaryReasoningParameter: definition.binaryReasoningParameter,
  }))
}

export function getProviderDefinition(providerId: string): ProviderDefinition {
  return definitions[requireProviderKey(providerId)]
}

/** Whether a provider needs a user-configured endpoint. */
export function providerRequiresBaseURL(providerId: string): boolean {
  return getProviderDefinition(providerId).requiresBaseURL ?? false
}

/** Non-standard chat response field containing streamed reasoning. */
export function providerReasoningField(providerId: string): string | undefined {
  return getProviderDefinition(providerId).chatCompletions?.reasoningField
}

/** Resolves the base endpoint used by an optimistic video chat request. */
export function resolveChatCompletionsBaseURL(
  providerId: string,
  baseURL?: string,
): string | undefined {
  const transport = getProviderDefinition(providerId).chatCompletions
  if (!transport) return undefined

  const resolved = baseURL || transport.defaultBaseURL
  if (!resolved) return undefined

  return stripEndpointSuffix(resolved, ['/responses', '/chat/completions'])
}

function stripEndpointSuffix(value: string, suffixes: string[]): string {
  const suffix = suffixes.find((candidate) => value.endsWith(candidate))
  return suffix ? value.slice(0, -suffix.length) : value
}

export function resolveModelReasoning(
  providerId: string,
  reasoning?: ModelReasoning,
): ModelReasoning {
  return (
    normalizeConfiguredReasoning(providerId, reasoning) ??
    getProviderDefinition(providerId).defaultReasoning
  )
}

/** Replaces the old generic binary default with a provider's native key. */
export function normalizeConfiguredReasoning(
  providerId: string,
  reasoning?: ModelReasoning,
): ModelReasoning | undefined {
  const parameter = getProviderDefinition(providerId).binaryReasoningParameter
  return normalizeBinaryReasoningParameter(reasoning, parameter)
}
