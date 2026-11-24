import type { Infer } from 'convex/values'

import type { Id } from '../../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../../_generated/server'
import { error } from '../../errors'
import { type ReplyQuote, authorKey } from '../../validators/messages'
import type {
  currentSessionArchiveValidator,
  sessionArchiveValidator,
} from '../../validators/sessionArchives'
import type { ImportSessionArgs } from '../../validators/sessions'
import {
  type MessageWithParts,
  insertMessage,
  withPartsMany,
} from '../messageContents'
import {
  finalizeMessageParts,
  messagePreview,
  notACommandChip,
} from '../messages'
import { portableContextExtra } from '../stream/contextNotes'
import { findUserBySubject } from '../users'
import {
  exportAuthors,
  importAuthors,
  normalizeArchive,
} from './archiveAuthors'
import { getMember } from './memberships'
import { resolveTitle } from './title'

export type SessionArchive = Infer<typeof sessionArchiveValidator>
export type CurrentSessionArchive = Infer<typeof currentSessionArchiveValidator>

type ArchiveMessage = CurrentSessionArchive['session']['messages'][number]
type ArchivedSenders = Awaited<ReturnType<typeof importAuthors>>

export type SessionArchiveExportData = {
  archive: CurrentSessionArchive
  avatars: Array<{
    key: string
    storageId: Id<'_storage'>
  }>
}

export async function exportOne(
  ctx: QueryCtx,
  { sessionId, subject }: { sessionId: Id<'sessions'>; subject: string },
): Promise<SessionArchiveExportData> {
  const user = await findUserBySubject(ctx, subject)
  if (!user) error('Profile not initialized', 409)

  const member = await getMember(ctx, sessionId, user._id)
  if (!member) error('Not found', 404)

  const messages = await ctx.db
    .query('messages')
    .withIndex('by_sessionId_position', (q) => q.eq('sessionId', sessionId))
    .filter(notACommandChip)
    .order('asc')
    .collect()

  const [messagesWithParts, { authors, avatars, authorKeys }] =
    await Promise.all([
      withPartsMany(ctx, messages),
      exportAuthors(ctx, sessionId, messages),
    ])

  const messageIndices = new Map(messages.map(({ _id }, index) => [_id, index]))

  return {
    archive: {
      version: 2,
      exportedAt: Date.now(),
      session: {
        title: resolveTitle(member.session.title, messagesWithParts),
        authors,
        messages: messagesWithParts.map((message) =>
          exportMessage(message, authorKeys, messageIndices),
        ),
      },
    },
    avatars,
  }
}

export async function importOne(
  ctx: MutationCtx,
  { payload, subject, avatars }: ImportSessionArgs,
) {
  const user = await findUserBySubject(ctx, subject)
  if (!user) error('Profile not initialized', 409)

  const { authors, messages } = normalizeArchive(payload)
  const imported = messages.map((message) => ({
    ...message,
    parts: sanitizeParts(finalizeMessageParts(message.parts)),
  }))
  const sessionId = await createImportedSession(ctx, {
    userId: user._id,
    title: payload.session.title.trim() || 'Imported chat',
    preview: messagePreview(imported.at(-1)?.parts ?? []),
  })
  const senders = await importAuthors(ctx, { sessionId, authors, avatars })
  await importMessages(ctx, sessionId, imported, senders)

  return { sessionId }
}

async function importMessages(
  ctx: MutationCtx,
  sessionId: Id<'sessions'>,
  messages: ArchiveMessage[],
  senders: ArchivedSenders,
) {
  const ids: Id<'messages'>[] = []
  for (const { authorKey, extra, parts, replyTo, ...fields } of messages) {
    const sender = senders.get(authorKey)!
    const { messageId } = await insertMessage(
      ctx,
      {
        ...fields,
        sessionId,
        sender,
        replyTo: replyTo && readArchiveQuote(replyTo, senders),
        extra:
          extra && 'event' in extra ? { ...extra, participant: sender } : extra,
        status: 'done',
        skipLinkPreviews: true,
      },
      parts,
    )
    ids.push(messageId)
  }
  await restoreReplyTargets(ctx, messages, ids, senders)
}

function readArchiveQuote(
  replyTo: NonNullable<ArchiveMessage['replyTo']>,
  senders: ArchivedSenders,
): ReplyQuote {
  return {
    sender: senders.get(replyTo.authorKey)!,
    senderName: replyTo.senderName,
    text: replyTo.text,
    rendered: replyTo.rendered,
  }
}

async function restoreReplyTargets(
  ctx: MutationCtx,
  messages: ArchiveMessage[],
  ids: Id<'messages'>[],
  senders: ArchivedSenders,
) {
  for (const [index, { replyTo }] of messages.entries()) {
    if (!replyTo) continue
    const { targetIndex } = replyTo
    if (targetIndex === undefined || targetIndex === index) continue
    const targetId = ids[targetIndex]
    if (!targetId) continue
    if (replyTo.authorKey !== messages[targetIndex].authorKey) continue
    const target = await ctx.db.get(targetId)
    if (!target) continue
    await ctx.db.patch(ids[index], {
      replyTo: {
        ...readArchiveQuote(replyTo, senders),
        target: { id: target._id, creationTime: target._creationTime },
      },
    })
  }
}

type ImportedSession = {
  userId: Id<'users'>
  title: string
  preview?: string
}

async function createImportedSession(
  ctx: MutationCtx,
  { userId, title, preview }: ImportedSession,
) {
  const now = Date.now()
  const sessionId = await ctx.db.insert('sessions', {
    ownerId: userId,
    title,
    lastMessageAt: now,
    lastMessagePreview: preview,
  })

  await ctx.db.insert('userSessions', {
    sessionId,
    userId,
    role: 'owner',
    groupKey: 'ungrouped',
    lastMessageAt: now,
    title,
  })
  return sessionId
}

function exportMessage(
  message: MessageWithParts,
  authorKeys: Map<string, string>,
  messageIndices: Map<Id<'messages'>, number>,
) {
  const extra = portableContextExtra(message)
  const { replyTo } = message
  return {
    role: message.role,
    type: message.type,
    hidden: message.hidden,
    extra:
      extra && 'event' in extra ? { ...extra, participant: undefined } : extra,
    parts: sanitizeParts(finalizeMessageParts(message.parts)),
    authorKey: authorKeys.get(authorKey(message.sender))!,
    senderName: message.senderName,
    replyTo: replyTo && {
      authorKey: authorKeys.get(authorKey(replyTo.sender))!,
      senderName: replyTo.senderName,
      text: replyTo.text,
      rendered: replyTo.rendered,
      targetIndex: replyTo.target && messageIndices.get(replyTo.target.id),
    },
    metadata: message.metadata,
  }
}

function sanitizeParts(parts: unknown[]) {
  return parts.map((part) => {
    if (!isRecord(part) || part.type !== 'file') return part

    const filename =
      typeof part.filename === 'string' && part.filename.trim()
        ? part.filename.trim()
        : 'attachment'

    return {
      type: 'text',
      text: `[Attachment omitted: ${filename}]`,
    }
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
