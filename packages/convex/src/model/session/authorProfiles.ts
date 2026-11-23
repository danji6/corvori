import { toOptionalName } from '@cv/core/utils/names'

import type { Doc, Id } from '../../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../../_generated/server'
import { error } from '../../errors'
import type { AuthMutationCtx, AuthQueryCtx } from '../../functions'
import { type MessageSender, authorKey } from '../../validators/messages'
import type {
  ConfirmSessionProfileAvatar,
  SessionProfileTarget,
  UpdateSessionProfile,
} from '../../validators/sessionAuthors'
import { _create as createAvatar, removeIfUnreferenced } from '../avatars'
import { getByOwnerId } from '../settings'
import { findUserBySubject } from '../users'
import { findLink } from './agents'
import { getMember, getMembership } from './memberships'

type LiveSender = Exclude<MessageSender, { type: 'archived' }>

export type AuthorProfile = Pick<
  Doc<'sessionAuthors'>,
  'kind' | 'name' | 'avatarId'
>

export function findOverride(
  ctx: QueryCtx,
  sessionId: Id<'sessions'>,
  sender: LiveSender,
) {
  return ctx.db
    .query('sessionProfiles')
    .withIndex('by_sessionId_sender', (q) =>
      q
        .eq('sessionId', sessionId)
        .eq('sender.type', sender.type)
        .eq('sender.id', sender.id),
    )
    .unique()
}

/** Resolves public attribution fields for a sender already authorized by the caller. */
export async function resolveAuthor(
  ctx: QueryCtx,
  sessionId: Id<'sessions'>,
  sender: MessageSender,
): Promise<AuthorProfile | null> {
  if (sender.type === 'archived') {
    const author = await ctx.db.get(sender.id)
    if (author?.sessionId !== sessionId) return null
    return { kind: author.kind, name: author.name, avatarId: author.avatarId }
  }

  const [override, profile] = await Promise.all([
    findOverride(ctx, sessionId, sender),
    readLiveProfile(ctx, sender),
  ])

  return {
    kind: sender.type,
    name: override?.name ?? profile.name,
    avatarId: override?.avatarId ?? profile.avatarId,
  }
}

async function readLiveProfile(ctx: QueryCtx, sender: LiveSender) {
  if (sender.type === 'agent') {
    const agent = await ctx.db.get(sender.id)
    return { name: toOptionalName(agent?.name), avatarId: agent?.avatarId }
  }
  const settings = await getByOwnerId(ctx, sender.id)
  return {
    name: toOptionalName(settings?.displayName),
    avatarId: settings?.avatarId,
  }
}

/** Reuses lookups for the same author within one query. */
export function authorResolver(ctx: QueryCtx, sessionId: Id<'sessions'>) {
  const profiles = new Map<string, Promise<AuthorProfile | null>>()
  return (sender: MessageSender) => {
    const key = authorKey(sender)
    const cached = profiles.get(key)
    if (cached) return cached
    const profile = resolveAuthor(ctx, sessionId, sender)
    profiles.set(key, profile)
    return profile
  }
}

type ArchivedAuthorKindsArgs = {
  sessionId: Id<'sessions'>
  ids: Id<'sessionAuthors'>[]
}

export async function getArchivedAuthorKinds(
  ctx: QueryCtx,
  { sessionId, ids }: ArchivedAuthorKindsArgs,
): Promise<Record<string, AuthorProfile['kind']>> {
  const rows = await Promise.all(ids.map((id) => ctx.db.get(id)))
  return Object.fromEntries(
    rows.flatMap((row) =>
      row?.sessionId === sessionId ? [[row._id, row.kind]] : [],
    ),
  )
}

export async function getProfile(
  ctx: AuthQueryCtx,
  target: SessionProfileTarget,
) {
  const { sessionId, sender } = target
  if (!(await getMember(ctx, sessionId, ctx.userId))) return null
  if (
    sender.type !== 'archived' &&
    !(await isKnownSender(ctx, sessionId, sender))
  )
    return null
  return resolveAuthor(ctx, sessionId, sender)
}

async function isKnownSender(
  ctx: QueryCtx,
  sessionId: Id<'sessions'>,
  sender: LiveSender,
) {
  const current = await (sender.type === 'user'
    ? getMembership(ctx, sessionId, sender.id)
    : findLink(ctx, { sessionId, agentId: sender.id }))
  if (current) return true

  const [message, reply] = await Promise.all([
    ctx.db
      .query('messages')
      .withIndex('by_sessionId_sender', (q) =>
        q
          .eq('sessionId', sessionId)
          .eq('sender.type', sender.type)
          .eq('sender.id', sender.id),
      )
      .first(),
    ctx.db
      .query('messages')
      .withIndex('by_sessionId_quotedSender', (q) =>
        q
          .eq('sessionId', sessionId)
          .eq('replyTo.sender.type', sender.type)
          .eq('replyTo.sender.id', sender.id),
      )
      .first(),
  ])
  return Boolean(message || reply)
}

export async function getEditableProfile(
  ctx: AuthQueryCtx,
  target: SessionProfileTarget,
) {
  const editable = await editableProfile(ctx, target)
  if (!editable) return null
  const inherited =
    target.sender.type === 'archived'
      ? undefined
      : await readLiveProfile(ctx, target.sender)
  return {
    name: editable.record?.name,
    avatarId: editable.record?.avatarId,
    inherited,
  }
}

export async function listImportedAuthors(
  ctx: AuthQueryCtx,
  { sessionId }: Pick<SessionProfileTarget, 'sessionId'>,
) {
  if (!(await getMember(ctx, sessionId, ctx.userId))) return []
  const authors = await listSessionAuthors(ctx, sessionId)
  return authors.map(({ _id, kind, name, avatarId }) => ({
    _id,
    kind,
    name,
    avatarId,
  }))
}

type ProfileReader = QueryCtx & { userId: Id<'users'> }

async function editableProfile(
  ctx: ProfileReader,
  { sessionId, sender }: SessionProfileTarget,
) {
  const member = await getMember(ctx, sessionId, ctx.userId)
  if (!member) return null

  if (sender.type === 'archived') {
    if (member.session.ownerId !== ctx.userId) return null
    const author = await ctx.db.get(sender.id)
    return author?.sessionId === sessionId ? { record: author } : null
  }
  if (sender.type === 'user' && sender.id !== ctx.userId) {
    return null
  }
  if (sender.type === 'agent') {
    const [agent, link] = await Promise.all([
      ctx.db.get(sender.id),
      findLink(ctx, { sessionId, agentId: sender.id }),
    ])
    if (agent?.ownerId !== ctx.userId || !link) return null
  }

  return { record: await findOverride(ctx, sessionId, sender) }
}

async function requireEditableProfile(
  ctx: ProfileReader,
  target: SessionProfileTarget,
) {
  const editable = await editableProfile(ctx, target)
  if (!editable) error('Forbidden', 403)
  return editable.record
}

export async function updateProfile(
  ctx: AuthMutationCtx,
  args: UpdateSessionProfile,
) {
  const record = await requireEditableProfile(ctx, args)
  const name = args.name === undefined ? record?.name : toOptionalName(args.name) // prettier-ignore
  const avatarId = args.resetAvatar ? undefined : record?.avatarId
  await saveProfile(ctx, args, record, { name, avatarId })
}

export async function confirmProfileAvatar(
  ctx: MutationCtx,
  args: ConfirmSessionProfileAvatar & { subject: string },
) {
  const user = await findUserBySubject(ctx, args.subject)
  if (!user) error('Profile not initialized', 409)

  const record = await requireEditableProfile({ ...ctx, userId: user._id }, args) // prettier-ignore
  const name = args.name === undefined ? record?.name : toOptionalName(args.name) // prettier-ignore
  const avatarId = await createAvatar(ctx, {
    storageId: args.originalStorageId,
    thumbStorageId: args.thumbStorageId,
  })

  await saveProfile(ctx, args, record, { name, avatarId })
  return avatarId
}

type ProfileRecord = Doc<'sessionProfiles'> | Doc<'sessionAuthors'> | null
type ProfileFields = Pick<AuthorProfile, 'name' | 'avatarId'>

async function saveProfile(
  ctx: MutationCtx,
  { sessionId, sender }: SessionProfileTarget,
  record: ProfileRecord,
  fields: ProfileFields,
) {
  if (sender.type === 'archived') {
    await ctx.db.patch(sender.id, fields)
  } else if (record) {
    if (fields.name || fields.avatarId) await ctx.db.patch(record._id, fields)
    else await ctx.db.delete(record._id)
  } else if (fields.name || fields.avatarId) {
    await ctx.db.insert('sessionProfiles', { sessionId, sender, ...fields })
  }

  if (record?.avatarId && record.avatarId !== fields.avatarId) {
    await removeIfUnreferenced(ctx, record.avatarId)
  }
}

export function listOverrides(ctx: QueryCtx, sessionId: Id<'sessions'>) {
  return ctx.db
    .query('sessionProfiles')
    .withIndex('by_sessionId_sender', (q) => q.eq('sessionId', sessionId))
    .collect()
}

export function listSessionAuthors(ctx: QueryCtx, sessionId: Id<'sessions'>) {
  return ctx.db
    .query('sessionAuthors')
    .withIndex('by_sessionId', (q) => q.eq('sessionId', sessionId))
    .collect()
}
