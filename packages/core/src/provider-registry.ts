export type ProviderAuth = 'apiKey' | 'chatgpt'

export const OPENAI_COMPATIBLE_PROVIDER_KEY = 'openai-compatible'

/** Derives a display name for an OpenAI-compatible connection. */
export function openAICompatibleName(baseURL?: string): string {
  try {
    return new URL(baseURL ?? '').hostname || 'OpenAI-compatible'
  } catch {
    return 'OpenAI-compatible'
  }
}

export const PROVIDER_AUTH_LABELS: Record<ProviderAuth, string> = {
  apiKey: 'API key',
  chatgpt: 'ChatGPT subscription',
}

export type ProviderFeatures = {
  accountSignIn?: boolean
  discovery?: boolean
  catalogOnly?: boolean
  fixedEndpoint?: boolean
  modelDetails?: boolean
}

export type ProviderDefinition = {
  name: string
  authentication: Partial<Record<ProviderAuth, ProviderFeatures>>
}

const definitions: Record<string, ProviderDefinition> = {
  openai: {
    name: 'OpenAI',
    authentication: {
      apiKey: { discovery: true },
      chatgpt: {
        discovery: true,
        accountSignIn: true,
        catalogOnly: true,
        fixedEndpoint: true,
      },
    },
  },
  openrouter: {
    name: 'OpenRouter',
    authentication: { apiKey: { discovery: true } },
  },
  anthropic: {
    name: 'Anthropic',
    authentication: { apiKey: { discovery: true } },
  },
  ollama: {
    name: 'Ollama',
    authentication: { apiKey: { discovery: true, modelDetails: true } },
  },
}

export function providerDefinition(id: string): ProviderDefinition {
  return Object.hasOwn(definitions, id)
    ? definitions[id]
    : { name: id, authentication: { apiKey: {} } }
}

export function providerFeatures(
  id: string,
  auth: ProviderAuth = 'apiKey',
): ProviderFeatures {
  return providerDefinition(id).authentication[auth] ?? {}
}
