import type { Id } from '../../_generated/dataModel'
import type { ActionCtx } from '../../_generated/server'
import { extractErrorMessage } from '../../errors'
import {
  allowedOrigin,
  jsonResponse,
  preflightResponse,
} from '../../lib/httpResponses'
import { uploadAvatar } from './actions'

export async function avatarUploadHandler(ctx: ActionCtx, req: Request) {
  const origin = allowedOrigin(req)

  if (req.method === 'OPTIONS') {
    return preflightResponse(origin)
  }

  const identity = await ctx.auth.getUserIdentity()
  if (!identity) {
    return jsonResponse({ error: 'Unauthorized' }, 401, origin)
  }

  const form = await req.formData()
  const target = form.get('target')
  const file = form.get('file')

  if (!(file instanceof Blob)) {
    return jsonResponse({ error: 'Missing file' }, 400, origin)
  }

  try {
    if (target === 'profile') {
      const result = await uploadAvatar(ctx, { target: 'profile', file })
      return jsonResponse(result, 200, origin)
    }

    const agentId = form.get('agentId')
    if (typeof agentId !== 'string') {
      return jsonResponse({ error: 'Missing agentId' }, 400, origin)
    }

    const result = await uploadAvatar(ctx, {
      target: 'agent',
      agentId: agentId as Id<'agents'>,
      file,
    })
    return jsonResponse(result, 200, origin)
  } catch (error) {
    return jsonResponse({ error: extractErrorMessage(error) }, 500, origin)
  }
}
