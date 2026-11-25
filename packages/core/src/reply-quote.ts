/** Longest excerpt of a quoted message kept on its reply. */
export const REPLY_QUOTE_MAX_CHARS = 600

type TextPart = { type: 'text'; text: string }

function isTextPart(part: unknown): part is TextPart {
  if (typeof part !== 'object' || part === null) return false
  const { type, text } = part as Record<string, unknown>
  return type === 'text' && typeof text === 'string'
}

/** Counts files in a message whose conversation content has no text. */
export function attachmentReplyCount(segments: Iterable<readonly unknown[]>) {
  let count = 0
  for (const parts of segments) {
    for (const part of parts) {
      if (isTextPart(part) && part.text.trim()) return 0
      if (
        typeof part === 'object' &&
        part !== null &&
        'type' in part &&
        part.type === 'file'
      ) {
        count++
      }
    }
  }
  return count
}

export function attachmentReplyLabel(count: number): string {
  if (count === 0) return ''
  return count === 1 ? '1 attachment' : `${count} attachments`
}

/**
 * Picks the text a quote shows from a run of message parts. An agent turn's
 * answer is its last text, past any narration between tool calls; everything
 * else is quoted from its start.
 */
export function quotableText(parts: unknown[], answerLast: boolean): string {
  const texts = parts
    .filter(isTextPart)
    .map((part) => part.text.trim())
    .filter(Boolean)

  return (answerLast ? texts[texts.length - 1] : texts.join('\n\n')) ?? ''
}

/** Shortens an excerpt without splitting a surrogate pair. */
export function clipReplyQuote(text: string): string {
  if (text.length <= REPLY_QUOTE_MAX_CHARS) return text

  const clipped = text.slice(0, REPLY_QUOTE_MAX_CHARS - 1)
  const endsMidPair = /[\uD800-\uDBFF]$/.test(clipped)
  return `${endsMidPair ? clipped.slice(0, -1) : clipped}…`
}
