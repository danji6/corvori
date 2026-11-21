import type { UserIdentity } from 'convex/server'

import type { Id } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import type { AuthMutationCtx, AuthQueryCtx } from '../functions'
import type { Role } from '../lib/roles'
import * as Settings from './settings'

export async function findUserBySubject(
  ctx: QueryCtx | MutationCtx,
  subject: string,
) {
  return ctx.db
    .query('users')
    .withIndex('by_subject', (q) => q.eq('subject', subject))
    .unique()
}

export async function getNewUserRole(ctx: QueryCtx | MutationCtx) {
  const firstUser = await ctx.db.query('users').first()
  return firstUser ? 'user' : 'admin'
}

/** Creates a profile and its initial settings on the first authenticated mutation. */
export async function provisionUser(
  ctx: MutationCtx,
  identity: UserIdentity,
): Promise<{ userId: Id<'users'>; role: Role }> {
  const existing = await findUserBySubject(ctx, identity.subject)
  if (existing) return { userId: existing._id, role: existing.role }

  const role = await getNewUserRole(ctx)
  const userId = await ctx.db.insert('users', {
    subject: identity.subject,
    role,
  })

  if (identity.name) {
    await Settings.ensureForUser(ctx, userId, { displayName: identity.name })
  }

  return { userId, role }
}

export async function getProfile(ctx: AuthQueryCtx) {
  return ctx.db.get(ctx.userId)
}

export async function _getRoleBySubject(
  ctx: QueryCtx,
  { subject }: { subject: string },
) {
  const user = await findUserBySubject(ctx, subject)
  return user?.role ?? null
}

export async function ensureProfile(ctx: AuthMutationCtx) {
  return ctx.db.get(ctx.userId)
}

export async function updateProfile(
  ctx: AuthMutationCtx,
  args: { displayName?: string },
) {
  await Settings.update(ctx, { patch: args })
}

export async function clearAvatar(ctx: AuthMutationCtx) {
  await Settings.clearAvatar(ctx)
}

export async function generateAvatarUploadUrl(ctx: AuthMutationCtx) {
  return ctx.storage.generateUploadUrl()
}

export async function confirmAvatarUpload(
  ctx: AuthMutationCtx,
  args: Parameters<typeof Settings.confirmAvatarUpload>[1],
) {
  return Settings.confirmAvatarUpload(ctx, args)
}
