'use node'

import { toReplyQuoteBlock } from '@cv/convex/lib/replyQuote'
import { INJECTED_BLOCK_PREFIXES } from '@cv/convex/lib/workspace'
import type { UIMessage } from 'ai'

import type { Doc } from '../../_generated/dataModel'

export function representMessage(
  stored: Doc<'messages'>,
  agent: Doc<'agents'>,
  parts: UIMessage['parts'],
) {
  const isOtherAgent =
    !stored.hidden &&
    stored.sender.type === 'agent' &&
    stored.sender.id !== agent._id
  const role = agent.maskOtherAgents && isOtherAgent ? 'user' : stored.role

  if (role === 'user') {
    return {
      role,
      // User messages shouldn't carry reasoning/tool parts
      parts: parts.filter(
        (part) => part.type === 'text' || part.type === 'file',
      ),
    }
  }

  return { role: stored.role, parts }
}

export function prefixSenderName(
  message: UIMessage,
  stored: Doc<'messages'>,
  agent: Doc<'agents'>,
) {
  const senderName = stored.senderName
  if (!senderName || stored.hidden) return message.parts

  if (!sharesDisplayName(stored.sender, agent)) return message.parts

  // Skip injected context blocks so the actual user message is prefixed instead
  const index = ownTextIndex(message.parts)
  if (index < 0) return message.parts

  return message.parts.map((part, partIndex) =>
    partIndex === index && part.type === 'text'
      ? { ...part, text: `${senderName}: ${part.text}` }
      : part,
  )
}

/** Places the excerpt a reply quotes right before the reply's own text. */
export function insertReplyQuote(
  message: UIMessage,
  stored: Doc<'messages'>,
  agent: Doc<'agents'>,
): UIMessage['parts'] {
  const quote = stored.replyTo
  if (!quote?.text) return message.parts

  const quotePart = {
    type: 'text' as const,
    text: toReplyQuoteBlock(quote.text, quotedSenderLabel(quote, agent)),
  }
  const index = ownTextIndex(message.parts)
  if (index < 0) return [...message.parts, quotePart]

  return [
    ...message.parts.slice(0, index),
    quotePart,
    ...message.parts.slice(index),
  ]
}

/** Names who is being quoted, as far as the agent may know. */
function quotedSenderLabel(
  quote: NonNullable<Doc<'messages'>['replyTo']>,
  agent: Doc<'agents'>,
) {
  const isOwnMessage =
    quote.sender.type === 'agent' && quote.sender.id === agent._id
  if (isOwnMessage) return 'you'

  return sharesDisplayName(quote.sender, agent) ? quote.senderName : undefined
}

/** Whether the agent is told the display name of another participant. */
function sharesDisplayName(
  sender: Doc<'messages'>['sender'],
  agent: Doc<'agents'>,
) {
  if (sender.type === 'user') return Boolean(agent.shareUserDisplayNames)
  return sender.id !== agent._id && Boolean(agent.shareAgentDisplayNames)
}

/** Index of the first text part the sender wrote, past injected blocks. */
function ownTextIndex(parts: UIMessage['parts']) {
  return parts.findIndex(
    (part) => part.type === 'text' && !isInjectedContextBlock(part.text),
  )
}

export function isInjectedContextBlock(text: string): boolean {
  return INJECTED_BLOCK_PREFIXES.some((prefix) => text.startsWith(prefix))
}
