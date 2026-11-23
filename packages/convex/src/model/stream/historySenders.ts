'use node'

import { toReplyQuoteBlock } from '@cv/convex/lib/replyQuote'
import { INJECTED_BLOCK_PREFIXES } from '@cv/convex/lib/workspace'
import { toDisplayName } from '@cv/core/utils/names'
import type { UIMessage } from 'ai'

import { internal } from '../../_generated/api'
import type { Doc, Id } from '../../_generated/dataModel'
import type { ActionCtx } from '../../_generated/server'
import type { MessageSender } from '../../validators/messages'
import { hasMessageScript } from '../messages'
import type { AuthorProfile } from '../session/authorProfiles'

type AuthorKind = AuthorProfile['kind']

/** Imported authors carry their role separately from the message's role. */
export async function readArchivedAuthorKinds(
  ctx: ActionCtx,
  sessionId: Id<'sessions'>,
  rows: Doc<'messages'>[],
  agent: Doc<'agents'>,
) {
  const refs = new Set<Id<'sessionAuthors'>>()

  const needsKind =
    agent.maskOtherAgents ||
    agent.shareUserDisplayNames ||
    agent.shareAgentDisplayNames
  if (needsKind) {
    for (const row of rows) {
      if (
        !row.hidden &&
        row.role !== 'system' &&
        row.sender.type === 'archived'
      ) {
        refs.add(row.sender.id)
      }
    }
  }

  const ids = [...refs]
  const kinds = new Map<string, AuthorKind>()

  for (let offset = 0; offset < ids.length; offset += 256) {
    const batch = await ctx.runQuery(internal.sessions._archivedAuthorKinds, {
      sessionId,
      ids: ids.slice(offset, offset + 256),
    })
    for (const [id, kind] of Object.entries(batch)) kinds.set(id, kind)
  }

  return (sender: MessageSender) =>
    sender.type === 'archived' ? kinds.get(sender.id) : undefined
}

export function representMessage(
  stored: Doc<'messages'>,
  agent: Doc<'agents'>,
  parts: UIMessage['parts'],
  archivedKind?: AuthorKind,
) {
  const isArchivedAgent =
    stored.sender.type === 'archived' &&
    stored.role !== 'system' &&
    archivedKind === 'agent'
  const isOtherAgent =
    !stored.hidden &&
    (stored.sender.type === 'agent' || isArchivedAgent) &&
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
  archivedKind?: AuthorKind,
) {
  const { senderName } = stored
  if (!senderName || stored.hidden || stored.role === 'system')
    return message.parts

  if (!sharesDisplayName(stored.sender, agent, archivedKind))
    return message.parts

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
): UIMessage['parts'] {
  const quote = stored.replyTo
  if (!quote?.text) return message.parts
  if (!quote.rendered && hasMessageScript(quote.text)) return message.parts

  const quotePart = {
    type: 'text' as const,
    text: toReplyQuoteBlock(quote.text, toDisplayName(quote.senderName)),
  }
  const index = ownTextIndex(message.parts)
  if (index < 0) return [...message.parts, quotePart]

  return [
    ...message.parts.slice(0, index),
    quotePart,
    ...message.parts.slice(index),
  ]
}

/** Whether ordinary messages include another participant's display name. */
function sharesDisplayName(
  sender: Doc<'messages'>['sender'],
  agent: Doc<'agents'>,
  archivedKind?: AuthorKind,
) {
  const kind = sender.type === 'archived' ? archivedKind : sender.type
  if (kind === 'user') return Boolean(agent.shareUserDisplayNames)
  return (
    kind === 'agent' &&
    sender.id !== agent._id &&
    Boolean(agent.shareAgentDisplayNames)
  )
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
