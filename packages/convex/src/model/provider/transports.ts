import type { ProviderTransportObserver } from '@cv/core/provider-continuity'

import {
  CHATGPT_OPENAI_OPTIONS,
  chatGPTFetch,
  chatGPTRequest,
  withChatGPTPolicy,
} from './openai/chatgpt'
import type { ProviderCredentials } from './providers'

export function inferenceTransport(
  connection: ProviderCredentials,
  observeTransport?: ProviderTransportObserver,
) {
  return connection.providerId === 'openai' && connection.auth === 'chatgpt'
    ? {
        fetch: chatGPTFetch(connection, observeTransport),
        transformRequest: chatGPTRequest(connection),
        options: CHATGPT_OPENAI_OPTIONS,
        wrap: withChatGPTPolicy,
      }
    : undefined
}
