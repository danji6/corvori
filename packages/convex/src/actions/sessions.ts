'use node'

import { v } from 'convex/values'

import { action, internalAction } from '../_generated/server'
import { sessionArchiveValidator } from '../validators/sessionArchives'
import { createSessionArgsValidator } from '../validators/sessions'

export const createWithWorkspace = action({
  args: createSessionArgsValidator.fields,
  handler: async (ctx, args) =>
    (await import('../model/session/workspaceActions')).createSession(
      ctx,
      args,
    ),
})

export const duplicate = action({
  args: {
    sessionId: v.id('sessions'),
    title: v.optional(v.string()),
  },
  handler: async (ctx, args) =>
    (await import('../model/session/fileActions')).duplicateSession(ctx, args),
})

export const regenerateTitle = action({
  args: { sessionId: v.id('sessions') },
  handler: async (ctx, args) =>
    (await import('../model/session/titleActions')).regenerateTitle(ctx, args),
})

export const exportOne = action({
  args: { sessionId: v.id('sessions') },
  handler: async (ctx, args) =>
    (await import('../model/session/archiveActions')).exportOne(ctx, args),
})

export const importOne = action({
  args: { payload: sessionArchiveValidator },
  handler: async (ctx, args) =>
    (await import('../model/session/archiveActions')).importOne(ctx, args),
})

export const _generateTitle = internalAction({
  args: {
    sessionId: v.id('sessions'),
    assistantText: v.optional(v.string()),
  },
  handler: async (ctx, args) =>
    (await import('../model/session/titleActions')).generateTitle(ctx, args),
})

export const _runSessionFileOperation = internalAction({
  args: { operationId: v.id('sessionFileOperations') },
  handler: async (ctx, args) => {
    const { runSessionFileOperation } = await import('../model/session/fileActions') // prettier-ignore
    return runSessionFileOperation(ctx, args)
  },
})

export const _cleanAttachmentTransfer = internalAction({
  args: { id: v.id('attachmentTransfers') },
  handler: async (ctx, args) => {
    const { cleanAttachmentTransfer } = await import('../model/attachments/actions') // prettier-ignore
    await cleanAttachmentTransfer(ctx, args)
  },
})
