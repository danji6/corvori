import { internal } from '../../_generated/api'
import type { Id } from '../../_generated/dataModel'
import type { MutationCtx } from '../../_generated/server'
import { error } from '../../errors'

const GRACE_PERIOD_MS = 60 * 60_000
const JOIN_AVATAR_TAG = '; corvori-upload=join-avatar'

export const joinAvatarContentType = {
  input: `image/webp${JOIN_AVATAR_TAG}`,
  original: `image/png${JOIN_AVATAR_TAG}`,
  thumbnail: `image/webp${JOIN_AVATAR_TAG}`,
}

export type JoinAvatarFiles = {
  storageId: Id<'_storage'>
  thumbStorageId: Id<'_storage'>
}

/** Rejects uploads that can already be reclaimed by the sweep. */
export async function validateJoinAvatarFiles(
  ctx: MutationCtx,
  { storageId, thumbStorageId }: JoinAvatarFiles,
) {
  const [original, thumbnail] = await Promise.all([
    ctx.db.system.get('_storage', storageId),
    ctx.db.system.get('_storage', thumbStorageId),
  ])
  const cutoff = Date.now() - GRACE_PERIOD_MS
  if (
    original?.contentType !== joinAvatarContentType.original ||
    thumbnail?.contentType !== joinAvatarContentType.thumbnail ||
    original._creationTime <= cutoff ||
    thumbnail._creationTime <= cutoff
  ) {
    error('The avatar upload expired or is incomplete. Try again.', 409)
  }
}

/** Reclaims join files, including when the redemption response was lost. */
export async function discardJoinAvatarFiles(
  ctx: MutationCtx,
  { ids }: { ids: Id<'_storage'>[] },
) {
  for (const id of ids) {
    const file = await ctx.db.system.get('_storage', id)
    if (file?.contentType?.endsWith(JOIN_AVATAR_TAG))
      await deleteIfUnclaimed(ctx, id)
  }
}

async function deleteIfUnclaimed(ctx: MutationCtx, id: Id<'_storage'>) {
  const [original, thumbnail] = await Promise.all([
    ctx.db
      .query('avatars')
      .withIndex('by_storageId', (q) => q.eq('storageId', id))
      .first(),
    ctx.db
      .query('avatars')
      .withIndex('by_thumbStorageId', (q) => q.eq('thumbStorageId', id))
      .first(),
  ])
  if (!original && !thumbnail) await ctx.storage.delete(id)
}

/** Finds files even when the HTTP action stopped immediately after storage. */
export async function sweepJoinAvatarFiles(
  ctx: MutationCtx,
  args: { cursor?: string; cutoff?: number },
) {
  const cutoff = args.cutoff ?? Date.now() - GRACE_PERIOD_MS
  const result = await ctx.db.system.query('_storage').paginate({
    cursor: args.cursor ?? null,
    numItems: 64,
    maximumRowsRead: 256,
  })
  for (const file of result.page) {
    if (file._creationTime > cutoff) break
    if (file.contentType?.endsWith(JOIN_AVATAR_TAG))
      await deleteIfUnclaimed(ctx, file._id)
  }
  const reachedRecentFiles = result.page.some(
    (file) => file._creationTime > cutoff,
  )
  if (!result.isDone && !reachedRecentFiles) {
    await ctx.scheduler.runAfter(0, internal.avatars._sweepJoinFiles, {
      cursor: result.continueCursor,
      cutoff,
    })
  }
}
