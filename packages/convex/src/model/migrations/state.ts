import type { MutationCtx, QueryCtx } from '../../_generated/server'

export async function getReleaseState(ctx: QueryCtx | MutationCtx) {
  return ctx.db
    .query('releaseState')
    .withIndex('by_key', (q) => q.eq('key', 'schema'))
    .unique()
}

export async function beginRelease(
  ctx: MutationCtx,
  { targetVersion }: { targetVersion: number },
) {
  const state = await getReleaseState(ctx)
  const value = {
    key: 'schema' as const,
    phase: 'migrating' as const,
    targetVersion,
    updatedAt: Date.now(),
    version: state?.version ?? 0,
  }

  if (state) await ctx.db.replace(state._id, value)
  else await ctx.db.insert('releaseState', value)
}

export async function markReleaseComplete(
  ctx: MutationCtx,
  { targetVersion }: { targetVersion: number },
) {
  const state = await getReleaseState(ctx)
  if (!state || state.targetVersion !== targetVersion) {
    throw new Error('Schema migration state does not match this release')
  }

  await ctx.db.patch(state._id, {
    phase: 'complete',
    updatedAt: Date.now(),
    version: targetVersion,
  })
}
