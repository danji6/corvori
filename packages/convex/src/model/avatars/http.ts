import type { Id } from '../../_generated/dataModel'
import type { ActionCtx } from '../../_generated/server'
import { extractErrorMessage } from '../../errors'
import {
  allowedOrigin,
  jsonResponse,
  preflightResponse,
} from '../../lib/httpResponses'
import type { MessageSender } from '../../validators/messages'
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

    if (target === 'session') {
      const sessionId = form.get('sessionId')
      const sender = readSender(form)
      const name = form.get('name')
      if (typeof sessionId !== 'string' || !sender) {
        return jsonResponse({ error: 'Invalid session author' }, 400, origin)
      }
      const result = await uploadAvatar(ctx, {
        target: 'session',
        sessionId: sessionId as Id<'sessions'>,
        sender,
        name: typeof name === 'string' ? name : undefined,
        file,
      })
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

function readSender(form: FormData): MessageSender | undefined {
  const id = form.get('senderId')
  if (typeof id !== 'string') return
  switch (form.get('senderType')) {
    case 'user':
      return { type: 'user', id: id as Id<'users'> }
    case 'agent':
      return { type: 'agent', id: id as Id<'agents'> }
    case 'archived':
      return { type: 'archived', id: id as Id<'sessionAuthors'> }
  }
}
