import type { Id } from '@cv/convex/_generated/dataModel'
import type { SessionProfileTarget } from '@cv/convex/validators/sessionAuthors'

import { ImageTool } from '../io'

const MAX_AVATAR_DIMENSION = 512

export type AvatarUploadResult = {
  avatarId: Id<'avatars'>
}

export async function avatarUploadForm(agentId: Id<'agents'>, file: File) {
  const form = await prepareAvatarUploadForm(file)
  form.set('target', 'agent')
  form.set('agentId', agentId)
  return form
}

export async function profileAvatarUploadForm(file: File) {
  const form = await prepareAvatarUploadForm(file)
  form.set('target', 'profile')
  return form
}

export async function sessionAvatarUploadForm(
  target: SessionProfileTarget,
  file: File,
  name?: string,
) {
  const form = await prepareAvatarUploadForm(file)
  form.set('target', 'session')
  form.set('sessionId', target.sessionId)
  form.set('senderType', target.sender.type)
  form.set('senderId', target.sender.id)
  if (name !== undefined) form.set('name', name)
  return form
}

/** Shrink avatars before sending them through the HTTP upload endpoint. */
async function prepareAvatarUploadForm(file: File) {
  const image = await new ImageTool(file)
    .resize(
      { width: MAX_AVATAR_DIMENSION, height: MAX_AVATAR_DIMENSION },
      'inside',
    )
    .format('image/webp')
    .compress(0.85)
    .toBlob()
  const form = new FormData()
  form.set('file', image, 'avatar.webp')
  return form
}
