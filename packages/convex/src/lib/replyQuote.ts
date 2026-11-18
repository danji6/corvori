import { block } from '@cv/core/utils/blocks'

const REPLY_QUOTE_TAG = 'reply'

/** Wraps a quoted excerpt so the agent can tell it apart from the reply. */
export function toReplyQuoteBlock(text: string, to: string) {
  return block(REPLY_QUOTE_TAG, text, { to })
}
