import {
  type MigrationFunctionReference,
  Migrations,
  runToCompletion,
} from '@convex-dev/migrations'
import { SCHEMA_MIGRATION_VERSION } from '@cv/core/migration-version'
import { getFunctionName } from 'convex/server'

import { components, internal } from '../../_generated/api'
import type { DataModel } from '../../_generated/dataModel'
import { type ActionCtx, internalMutation } from '../../_generated/server'

export const migrations = new Migrations<DataModel>(components.migrations, {
  internalMutation,
})

/**
 * Migrations an install must apply before this release can read its database,
 * in the order they have to run.
 *
 * Public migrations use the append-only shared manifest.
 */
const releaseMigrations: MigrationFunctionReference[] = []

export async function applyRelease(ctx: ActionCtx): Promise<string> {
  await ctx.runMutation(internal.migrations._beginRelease, {
    targetVersion: SCHEMA_MIGRATION_VERSION,
  })
  const statuses = await migrations.getStatus(ctx, {
    migrations: releaseMigrations,
  })
  const completed = new Set(
    statuses.filter((status) => status.isDone).map((status) => status.name),
  )
  let applied = 0

  for (const migration of releaseMigrations) {
    if (completed.has(getFunctionName(migration))) continue
    await runToCompletion(ctx, components.migrations, migration)
    applied += 1
  }

  return applied === 0
    ? 'No pending migrations.'
    : `Applied ${applied} migration${applied === 1 ? '' : 's'}.`
}

export async function completeRelease(ctx: ActionCtx): Promise<void> {
  const statuses = await migrations.getStatus(ctx, {
    migrations: releaseMigrations,
  })
  const incomplete = statuses.filter((status) => !status.isDone)
  if (incomplete.length > 0) {
    throw new Error(
      `Cannot complete release with ${incomplete.length} pending migrations`,
    )
  }

  await ctx.runMutation(internal.migrations._markReleaseComplete, {
    targetVersion: SCHEMA_MIGRATION_VERSION,
  })
}
