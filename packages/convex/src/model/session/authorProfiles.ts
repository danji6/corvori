import { toDisplayName, toOptionalName } from '@cv/core/utils/names'

import type { Doc, Id } from '../../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../../_generated/server'
import { error } from '../../errors'
import type { AuthMutationCtx, AuthQueryCtx } from '../../functions'
import { type MessageSender, authorKey } from '../../validators/messages'
import type {
  ConfirmSessionProfileAvatar,
  SessionProfileChanges,
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
    return {
      kind: author.kind,
      name: resolveName(author.name),
      avatarId: author.avatarId,
    }
  }

  const [override, profile] = await Promise.all([
    findOverride(ctx, sessionId, sender),
    readLiveProfile(ctx, sender),
  ])

  return {
    kind: sender.type,
    name: resolveName(override?.name) ?? profile.name,
    avatarId:
      override?.avatarId === null
        ? undefined
        : (override?.avatarId ?? profile.avatarId),
  }
}

function resolveName(name: string | undefined) {
  return name === undefined ? undefined : toDisplayName(name)
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
  return describeProfile(ctx, target.sender, editable.record)
}

/** Reads the caller's saved identity after the invite has been authorized. */
export async function getJoiningProfile(
  ctx: QueryCtx,
  sessionId: Id<'sessions'>,
  userId: Id<'users'>,
) {
  const sender = { type: 'user', id: userId } as const
  return describeProfile(
    ctx,
    sender,
    await findOverride(ctx, sessionId, sender),
  )
}

async function describeProfile(
  ctx: QueryCtx,
  sender: MessageSender,
  record: ProfileRecord,
) {
  const inherited =
    sender.type === 'archived' ? undefined : await readLiveProfile(ctx, sender)
  return {
    name: record?.name,
    avatarId: record?.avatarId,
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
  await saveProfile(ctx, args, record, applyChanges(record, args))
}

export async function saveJoiningProfile(
  ctx: MutationCtx,
  target: {
    sessionId: Id<'sessions'>
    sender: { type: 'user'; id: Id<'users'> }
  },
  changes: SessionProfileChanges,
  avatarId?: Id<'avatars'>,
) {
  const record = await findOverride(ctx, target.sessionId, target.sender)
  const fields = applyChanges(record, changes)
  if (avatarId) fields.avatarId = avatarId
  await saveProfile(ctx, target, record, fields)
}

function applyChanges(
  record: ProfileRecord,
  changes: SessionProfileChanges,
): ProfileFields {
  const name = applyNameChange(record, changes.name)
  let avatarId = record?.avatarId
  if (changes.avatar === 'inherit') avatarId = undefined
  if (changes.avatar === 'clear') avatarId = null
  return { name, avatarId }
}

/** Keeps an empty name as an explicit override. Null restores inheritance. */
function applyNameChange(
  record: ProfileRecord,
  name: SessionProfileChanges['name'],
) {
  return name === undefined ? record?.name : name?.trim()
}

export async function confirmProfileAvatar(
  ctx: MutationCtx,
  args: ConfirmSessionProfileAvatar & { subject: string },
) {
  const user = await findUserBySubject(ctx, args.subject)
  if (!user) error('Profile not initialized', 409)

  const record = await requireEditableProfile({ ...ctx, userId: user._id }, args) // prettier-ignore
  const name = applyNameChange(record, args.name)
  const avatarId = await createAvatar(ctx, {
    storageId: args.originalStorageId,
    thumbStorageId: args.thumbStorageId,
  })

  await saveProfile(ctx, args, record, { name, avatarId })
  return avatarId
}

type ProfileRecord = Doc<'sessionProfiles'> | Doc<'sessionAuthors'> | null
type ProfileFields = Pick<Doc<'sessionProfiles'>, 'name' | 'avatarId'>

async function saveProfile(
  ctx: MutationCtx,
  { sessionId, sender }: SessionProfileTarget,
  record: ProfileRecord,
  fields: ProfileFields,
) {
  const hasOverride = fields.name !== undefined || fields.avatarId !== undefined
  if (sender.type === 'archived') {
    await ctx.db.patch(sender.id, {
      ...fields,
      avatarId: fields.avatarId ?? undefined,
    })
  } else if (record) {
    if (hasOverride) await ctx.db.patch(record._id, fields)
    else await ctx.db.delete(record._id)
  } else if (hasOverride) {
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
