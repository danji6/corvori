import type { Id } from '../../_generated/dataModel'
import { error } from '../../errors'
import type { AuthMutationCtx, AuthQueryCtx } from '../../functions'
import { generateId } from '../../lib/utils'
import type { SessionProfileChanges } from '../../validators/sessionAuthors'
import { _create as createAvatar } from '../avatars'
import {
  type JoinAvatarFiles,
  validateJoinAvatarFiles,
} from '../avatars/joinStorage'
import { getJoiningProfile, saveJoiningProfile } from './authorProfiles'
import { getMember, getMembership, requireOwner } from './memberships'
import { announcePresence } from './presence'

export async function list(
  ctx: AuthQueryCtx,
  { sessionId }: { sessionId: Id<'sessions'> },
) {
  const member = await getMember(ctx, sessionId, ctx.userId)
  if (!member) return []
  if (member.membership.role !== 'owner') error('Forbidden', 403)
  return ctx.db
    .query('sessionShares')
    .withIndex('by_sessionId', (q) => q.eq('sessionId', sessionId))
    .collect()
}

export async function createOrRotate(
  ctx: AuthMutationCtx,
  { sessionId }: { sessionId: Id<'sessions'> },
) {
  await requireOwner(ctx, sessionId, ctx.userId)

  const existing = await ctx.db
    .query('sessionShares')
    .withIndex('by_sessionId', (q) => q.eq('sessionId', sessionId))
    .collect()

  for (const share of existing) {
    if (!share.revokedAt)
      await ctx.db.patch(share._id, { revokedAt: Date.now() })
  }

  const token = generateId()
  const shareId = await ctx.db.insert('sessionShares', {
    sessionId,
    createdBy: ctx.userId,
    tokenHash: await hashToken(token),
  })

  return { shareId, token }
}

export async function revoke(
  ctx: AuthMutationCtx,
  {
    sessionId,
    shareId,
  }: {
    sessionId: Id<'sessions'>
    shareId: Id<'sessionShares'>
  },
) {
  await requireOwner(ctx, sessionId, ctx.userId)
  const share = await ctx.db.get(shareId)
  if (share?.sessionId === sessionId) {
    await ctx.db.patch(shareId, { revokedAt: Date.now() })
  }
}

async function getInvitedSession(ctx: AuthQueryCtx, token: string) {
  const tokenHash = await hashToken(token.trim())
  const share = await ctx.db
    .query('sessionShares')
    .withIndex('by_tokenHash', (q) => q.eq('tokenHash', tokenHash))
    .unique()
  if (!share || share.revokedAt) return null
  return ctx.db.get(share.sessionId)
}

export async function preview(ctx: AuthQueryCtx, { token }: { token: string }) {
  const session = await getInvitedSession(ctx, token)
  if (!session) return null
  const member = await getMembership(ctx, session._id, ctx.userId)
  if (member) return { isMember: true as const, sessionId: session._id }
  return {
    isMember: false as const,
    profile: await getJoiningProfile(ctx, session._id, ctx.userId),
  }
}

type RedeemArgs = {
  token: string
  profile?: SessionProfileChanges
}

export async function redeem(ctx: AuthMutationCtx, args: RedeemArgs) {
  return redeemInvite(ctx, args)
}

export async function redeemInvite(
  ctx: AuthMutationCtx,
  { token, profile }: RedeemArgs,
  files?: JoinAvatarFiles,
) {
  const session = await getInvitedSession(ctx, token)
  if (!session) return null

  const sessionId = session._id
  const existing = await getMembership(ctx, sessionId, ctx.userId)
  if (existing) return sessionId

  if (files) await validateJoinAvatarFiles(ctx, files)

  const avatarId = files ? await createAvatar(ctx, files) : undefined
  const sender = { type: 'user', id: ctx.userId } as const

  if (profile || avatarId) {
    await saveJoiningProfile(
      ctx,
      { sessionId, sender },
      profile ?? {},
      avatarId,
    )
  }

  await ctx.db.insert('userSessions', {
    sessionId,
    userId: ctx.userId,
    role: 'member',
    hidden: session.taskRunId ? true : undefined,
    groupKey: 'ungrouped',
    lastMessageAt: session.lastMessageAt,
    title: session.title,
  })
  await announcePresence(ctx, {
    sessionId,
    participant: sender,
    event: 'joined',
  })

  return sessionId
}

async function hashToken(token: string) {
  const bytes = new TextEncoder().encode(token)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}
