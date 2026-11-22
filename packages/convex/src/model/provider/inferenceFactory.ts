import { OPENAI_COMPATIBLE_PROVIDER_KEY } from '@cv/core/provider-registry'

import type { InferenceAdapter } from './inferenceTypes'
import { type ProviderKey, requireProviderKey } from './known'

const loadCompatible = () => import('./compatible/inference')

const adapters: Record<
  ProviderKey,
  () => Promise<{ create: InferenceAdapter }>
> = {
  anthropic: () => import('./anthropic/inference'),
  alibaba: () => import('./alibaba/inference'),
  deepseek: () => import('./deepseek/inference'),
  mistral: () => import('./mistral/inference'),
  moonshotai: () => import('./moonshotai/inference'),
  openai: () => import('./openai/inference'),
  openrouter: () => import('./openrouter/inference'),
  ollama: () => import('./ollama/inference'),
  qwen: loadCompatible,
  [OPENAI_COMPATIBLE_PROVIDER_KEY]: loadCompatible,
}
export async function inferenceAdapter(
  provider: string,
): Promise<InferenceAdapter> {
  const load = adapters[requireProviderKey(provider)]
  return (await load()).create
}
