import type { Id } from '../../_generated/dataModel'
import type { MutationCtx } from '../../_generated/server'
import { error } from '../../errors'
import type { MessageSender } from '../../validators/messages'
import { removeIfUnreferenced } from '../avatars'
import { listOverrides, listSessionAuthors } from './authorProfiles'

export async function duplicateAuthorProfiles(
  ctx: MutationCtx,
  source: Id<'sessions'>,
  sessionId: Id<'sessions'>,
) {
  const [overrides, authors] = await Promise.all([
    listOverrides(ctx, source),
    listSessionAuthors(ctx, source),
  ])
  for (const { sender, name, avatarId } of overrides) {
    await ctx.db.insert('sessionProfiles', {
      sessionId,
      sender,
      name,
      avatarId,
    })
  }

  const copies = new Map<Id<'sessionAuthors'>, Id<'sessionAuthors'>>()
  for (const { _id, kind, name, avatarId } of authors) {
    const copy = await ctx.db.insert('sessionAuthors', {
      sessionId,
      kind,
      name,
      avatarId,
    })
    copies.set(_id, copy)
  }

  return (sender: MessageSender): MessageSender => {
    if (sender.type !== 'archived') return sender
    const id = copies.get(sender.id)
    if (!id) error('Archived author not found', 409)
    return { type: 'archived', id }
  }
}

export async function removeAuthorProfiles(
  ctx: MutationCtx,
  sessionId: Id<'sessions'>,
) {
  const [overrides, authors] = await Promise.all([
    listOverrides(ctx, sessionId),
    listSessionAuthors(ctx, sessionId),
  ])
  const avatars = new Set<Id<'avatars'>>()
  for (const { _id, avatarId } of [...overrides, ...authors]) {
    if (avatarId) avatars.add(avatarId)
    await ctx.db.delete(_id)
  }
  for (const id of avatars) await removeIfUnreferenced(ctx, id)
}
