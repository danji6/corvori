import { toOptionalName } from '@cv/core/utils/names'

import type { Doc, Id } from '../../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../../_generated/server'
import { error } from '../../errors'
import { type MessageSender, authorKey } from '../../validators/messages'
import type { CurrentSessionArchive, SessionArchive } from './archive'
import { authorResolver } from './authorProfiles'

type ArchiveAuthor = CurrentSessionArchive['session']['authors'][number]
type ArchiveMessage = CurrentSessionArchive['session']['messages'][number]

export async function exportAuthors(
  ctx: QueryCtx,
  sessionId: Id<'sessions'>,
  messages: Doc<'messages'>[],
) {
  const bySender = new Map(
    messages.flatMap(({ sender, replyTo }) =>
      [sender, ...(replyTo ? [replyTo.sender] : [])].map(
        (ref) => [authorKey(ref), ref] as const,
      ),
    ),
  )
  const resolve = authorResolver(ctx, sessionId)
  const entries = await Promise.all(
    [...bySender.entries()].map(async ([senderKey, sender], index) => {
      const profile = await resolve(sender)
      const kind =
        sender.type === 'archived' ? (profile?.kind ?? 'user') : sender.type
      return [
        senderKey,
        {
          key: String(index + 1),
          kind,
          name: profile?.name,
          avatarKey: profile?.avatarId,
        },
      ] as const
    }),
  )

  const avatarIds = new Set(
    entries.flatMap(([, entry]) => (entry.avatarKey ? [entry.avatarKey] : [])),
  )
  const records = await Promise.all([...avatarIds].map((id) => ctx.db.get(id)))
  const avatars = records.flatMap((row) =>
    row ? [{ key: row._id, storageId: row.storageId }] : [],
  )
  const localAvatarKeys = new Map(
    avatars.map(({ key }, index) => [key, String(index + 1)]),
  )
  const authors: ArchiveAuthor[] = entries.map(([, entry]) => ({
    ...entry,
    avatarKey: entry.avatarKey && localAvatarKeys.get(entry.avatarKey),
  }))
  const authorKeys = new Map(
    entries.map(([senderKey, entry]) => [senderKey, entry.key]),
  )

  return {
    authors,
    avatars: avatars.map(({ key, storageId }) => ({
      key: localAvatarKeys.get(key)!,
      storageId,
    })),
    authorKeys,
  }
}

export function normalizeArchive(payload: SessionArchive) {
  if (payload.version === 2) {
    const { authors, messages } = payload.session
    const keys = new Set(authors.map(({ key }) => key))
    if (
      keys.size !== authors.length ||
      messages.some(
        ({ authorKey, replyTo }) =>
          !keys.has(authorKey) || (replyTo && !keys.has(replyTo.authorKey)),
      )
    ) {
      error('Invalid archive author references', 400)
    }
    return { authors, messages }
  }

  const authors = new Map<string, ArchiveAuthor>()
  const messages: ArchiveMessage[] = payload.session.messages.map(
    ({ senderSnapshot, ...message }) => {
      const snapshot = message.role === 'system' ? undefined : senderSnapshot
      const name = toOptionalName(snapshot?.name)
      const avatarKey = snapshot?.avatarKey
      const identity = JSON.stringify([message.role, name, avatarKey])
      let author = authors.get(identity)
      if (!author) {
        author = {
          key: String(authors.size + 1),
          kind: message.role === 'assistant' ? 'agent' : message.role,
          name,
          avatarKey,
        }
        authors.set(identity, author)
      }
      return { ...message, authorKey: author.key, senderName: name ?? null }
    },
  )
  return { authors: [...authors.values()], messages }
}

type ImportAuthorsArgs = {
  sessionId: Id<'sessions'>
  authors: ArchiveAuthor[]
  avatars: Record<string, Id<'_storage'>>
}

export async function importAuthors(
  ctx: MutationCtx,
  { sessionId, authors, avatars }: ImportAuthorsArgs,
) {
  const avatarIds = new Map<string, Id<'avatars'>>()
  for (const [key, storageId] of Object.entries(avatars)) {
    const id = await ctx.db.insert('avatars', {
      storageId,
      thumbStorageId: storageId,
    })
    avatarIds.set(key, id)
  }

  const senders = new Map<
    string,
    Extract<MessageSender, { type: 'archived' }>
  >()
  for (const { key, kind, name, avatarKey } of authors) {
    const id = await ctx.db.insert('sessionAuthors', {
      sessionId,
      kind,
      name: toOptionalName(name),
      avatarId: avatarKey === undefined ? undefined : avatarIds.get(avatarKey),
    })
    senders.set(key, { type: 'archived', id })
  }
  return senders
}
