import {
  CHATGPT_OPENAI_OPTIONS,
  chatGPTFetch,
  chatGPTRequest,
  withChatGPTPolicy,
} from './openai/chatgpt'
import type { ProviderRequestOptions } from './options'
import type { ProviderCredentials } from './providers'

export function inferenceTransport(
  connection: ProviderCredentials,
  {
    resolveCacheId,
    observeTransport,
  }: Pick<ProviderRequestOptions, 'resolveCacheId' | 'observeTransport'>,
) {
  return connection.providerId === 'openai' && connection.auth === 'chatgpt'
    ? {
        fetch: chatGPTFetch(connection, observeTransport),
        transformRequest: chatGPTRequest(connection, resolveCacheId),
        options: CHATGPT_OPENAI_OPTIONS,
        wrap: withChatGPTPolicy,
      }
    : undefined
}
