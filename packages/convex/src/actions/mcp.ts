'use node'

import { action, internalAction } from '../_generated/server'
import * as V from '../validators/mcp'

export const discoverMcpTools = action({
  args: V.discoverMcpToolsArgsValidator.fields,
  handler: async (ctx, args) => {
    const { discoverMcpTools } = await import('../model/mcp/discoveryActions')
    return discoverMcpTools(ctx, args)
  },
})

export const _cleanup = internalAction({
  args: V.mcpCleanupArgsValidator.fields,
  handler: async (ctx, args) => {
    const { cleanup } = await import('../model/mcp/runtimeActions')
    await cleanup(ctx, args)
  },
})

export const _reconcile = internalAction({
  args: {},
  handler: async (ctx) => {
    const { reconcile } = await import('../model/mcp/runtimeActions')
    await reconcile(ctx)
  },
})

export const runtimeStatus = action({
  args: V.mcpRuntimeArgsValidator.fields,
  handler: async (ctx, args) => {
    const { runtimeStatus } = await import('../model/mcp/runtimeActions')
    return runtimeStatus(ctx, args)
  },
})
