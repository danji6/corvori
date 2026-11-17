import { block } from '@cv/core/utils/blocks'

const REPLY_QUOTE_TAG = 'reply-to'

/** Prefix of the quote block (see INJECTED_BLOCK_PREFIXES). */
export const REPLY_QUOTE_BLOCK_PREFIX = `<${REPLY_QUOTE_TAG}`

/** Wraps a quoted excerpt so the agent can tell it apart from the reply. */
export function toReplyQuoteBlock(text: string, from?: string) {
  return block(REPLY_QUOTE_TAG, text, from ? { from } : {})
}
