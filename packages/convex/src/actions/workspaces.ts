'use node'

import { v } from 'convex/values'

import { action, internalAction } from '../_generated/server'
import { settleChangesArgsValidator } from '../validators/changes'

export const listDirectories = action({
  args: { path: v.optional(v.string()), showHidden: v.optional(v.boolean()) },
  handler: async (ctx, args) =>
    (await import('../model/session/workspaceActions')).listDirectories(
      ctx,
      args,
    ),
})

export const listFiles = action({
  args: { sessionId: v.id('sessions') },
  handler: async (ctx, args) => {
    const { listWorkspaceFiles } = await import('../model/session/workspaceActions') // prettier-ignore
    return listWorkspaceFiles(ctx, args)
  },
})

export const listFilesByRoot = action({
  args: { root: v.string() },
  handler: async (ctx, args) =>
    (await import('../model/session/workspaceActions')).listFilesByRoot(
      ctx,
      args,
    ),
})

export const resolveFileLinks = action({
  args: { sessionId: v.id('sessions'), paths: v.array(v.string()) },
  handler: async (ctx, args) => {
    const { resolveFileLinks } = await import('../model/session/workspaceActions') // prettier-ignore
    return resolveFileLinks(ctx, args)
  },
})

export const _finishChanges = internalAction({
  args: { changeSetId: v.id('changeSets') },
  handler: async (ctx, args) =>
    (await import('../model/changes/actions')).finishChanges(ctx, args),
})

export const _settleChanges = internalAction({
  args: settleChangesArgsValidator.fields,
  handler: async (ctx, args) =>
    (await import('../model/changes/actions')).settleChanges(ctx, args),
})

export const _restoreChanges = internalAction({
  args: { changeSetId: v.id('changeSets'), operationId: v.string() },
  handler: async (ctx, args) =>
    (await import('../model/changes/actions')).restoreChanges(ctx, args),
})

export const checkpointStatus = action({
  args: { changeSetId: v.id('changeSets') },
  handler: async (ctx, args): Promise<{ stale: boolean }> =>
    (await import('../model/changes/actions')).checkpointStatus(ctx, args),
})

export const _removeChanges = internalAction({
  args: { sessionId: v.id('sessions') },
  handler: async (ctx, args) =>
    (await import('../model/changes/actions')).removeChanges(ctx, args),
})

export const _finishChangesParticipant = internalAction({
  args: { changeSetId: v.id('changeSets'), participantId: v.string() },
  handler: async (ctx, args) =>
    (await import('../model/changes/actions')).finishParticipantChanges(
      ctx,
      args,
    ),
})
