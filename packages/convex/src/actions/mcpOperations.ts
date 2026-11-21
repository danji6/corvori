'use node'

import { internalAction } from '../_generated/server'
import { mcpOperationArgsValidator } from '../validators/mcpOperations'

export const _settle = internalAction({
  args: mcpOperationArgsValidator.fields,
  handler: async (ctx, args) => {
    const { settle } = await import('../model/mcp/operations/actions')
    await settle(ctx, args)
  },
})

export const _reconcile = internalAction({
  args: {},
  handler: async (ctx) => {
    const { reconcileOperations } =
      await import('../model/mcp/operations/actions')
    await reconcileOperations(ctx)
  },
})
