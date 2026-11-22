export const PROVIDER_PLACEHOLDERS = {
  cacheId:
    "An ID calculated by hashing the session's initial prompts and message." +
    ' Useful when the provider requires a stable ID to cache requests.',
} as const

export type ProviderPlaceholderName = keyof typeof PROVIDER_PLACEHOLDERS
