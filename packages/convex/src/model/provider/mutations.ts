import type { Id } from '../../_generated/dataModel'
import type { MutationCtx } from '../../_generated/server'
import type { AuthMutationCtx } from '../../functions'
import type {
  CreateModelProviderArgs,
  UpdateModelProviderArgs,
} from '../../types'
import { refreshForOwner } from '../session/models'
import * as Catalog from './catalog'
import * as Connections from './connections'

export async function create(
  ctx: AuthMutationCtx,
  args: CreateModelProviderArgs,
) {
  const id = await Connections.create(ctx, args)
  await refreshForOwner(ctx, ctx.userId)
  return id
}

export async function update(
  ctx: AuthMutationCtx,
  args: UpdateModelProviderArgs,
) {
  await Connections.update(ctx, args)
  if (args.models) await refreshForOwner(ctx, ctx.userId)
}

export async function remove(
  ctx: AuthMutationCtx,
  args: { providerId: Id<'modelProviders'> },
) {
  await Connections.remove(ctx, args)
  await refreshForOwner(ctx, ctx.userId)
}

export async function finishDiscovery(
  ctx: MutationCtx,
  args: Parameters<typeof Catalog.finish>[1],
) {
  const published = await Catalog.finish(ctx, args)
  if (published) await refreshForOwner(ctx, args.ownerId)
}

export async function enrichModel(
  ctx: MutationCtx,
  args: Parameters<typeof Catalog.enrich>[1],
) {
  const updated = await Catalog.enrich(ctx, args)
  if (updated) await refreshForOwner(ctx, args.ownerId)
}
