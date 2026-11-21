'use node'

import { internalAction } from '../_generated/server'
import { shellJobExecutionArgsValidator } from '../validators/shell'

export const _watch = internalAction({
  args: shellJobExecutionArgsValidator.fields,
  handler: async (ctx, args) => {
    const { _watch } = await import('../model/shell/jobActions')
    return _watch(ctx, args)
  },
})
