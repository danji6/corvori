'use node'

import { v } from 'convex/values'

import { action } from '../_generated/server'

export const exportAsImage = action({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args) =>
    (await import('../model/agent/archiveActions')).exportAsImage(ctx, args),
})

export const importFromImage = action({
  args: { storageId: v.id('_storage') },
  handler: async (ctx, args) =>
    (await import('../model/agent/archiveActions')).importFromImage(ctx, args),
})

export const importFromJson = action({
  args: { data: v.any() },
  handler: async (ctx, args) => {
    const { importFromJson } = await import('../model/agent/archiveActions')
    return importFromJson(ctx, args)
  },
})
