import type { QueryCtx } from '../../_generated/server'
import { error } from '../../errors'
import { requireRole } from '../../functions'
import type { StreamExecutionArgs } from '../../types'
import { requireExecution } from '../mcp/operations/access'
import { hasInvocationAccess } from '../mcp/runtime'
import { availableToolkits } from './access'

export async function executionToolkits(
  ctx: QueryCtx,
  args: StreamExecutionArgs,
) {
  const stream = await requireExecution(ctx, args)
  const invoker = await ctx.db.get(stream.invokedBy)
  requireRole(invoker?.role, 'admin')
  if (!(await hasInvocationAccess(ctx, stream.sessionId, stream.invokedBy)))
    error('Toolkit access revoked', 403)
  return availableToolkits(ctx, stream.agentId, stream.sessionId)
}
