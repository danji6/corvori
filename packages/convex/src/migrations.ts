import { v } from 'convex/values'

import {
  internalAction,
  internalMutation,
  internalQuery,
} from './_generated/server'
import {
  applyRelease,
  completeRelease,
  migrations,
} from './model/migrations/release'
import {
  beginRelease,
  getReleaseState,
  markReleaseComplete,
} from './model/migrations/state'

export { migrations }

export const run = migrations.runner()

/** Stable pre-deploy endpoint used by launchers from future releases. */
export const _getReleaseState = internalQuery({
  args: {},
  handler: getReleaseState,
})

export const _beginRelease = internalMutation({
  args: { targetVersion: v.number() },
  handler: beginRelease,
})

export const _markReleaseComplete = internalMutation({
  args: { targetVersion: v.number() },
  handler: markReleaseComplete,
})

/** Applies pending release migrations and resumes a partial run. */
export const _applyRelease = internalAction({
  args: {},
  handler: applyRelease,
})

/** Records completion after the launcher has restored strict validation. */
export const _completeRelease = internalAction({
  args: {},
  handler: completeRelease,
})
