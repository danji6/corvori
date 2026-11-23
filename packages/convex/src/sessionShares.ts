import { v } from 'convex/values'

import { internalMutation } from './_generated/server'
import { error } from './errors'
import { authMutation, authQuery } from './functions'
import * as Shares from './model/session/shares'
import { findUserBySubject } from './model/users'
import { sessionProfileChangesValidator } from './validators/sessionAuthors'

const redeemArgs = {
  token: v.string(),
  profile: v.optional(sessionProfileChangesValidator),
}

export const list = authQuery({
  args: { sessionId: v.id('sessions') },
  handler: Shares.list,
})

export const createOrRotate = authMutation({
  args: { sessionId: v.id('sessions') },
  handler: Shares.createOrRotate,
})

export const revoke = authMutation({
  args: { sessionId: v.id('sessions'), shareId: v.id('sessionShares') },
  handler: Shares.revoke,
})

export const redeem = authMutation({
  args: redeemArgs,
  handler: Shares.redeem,
})

export const preview = authQuery({
  args: { token: v.string() },
  handler: Shares.preview,
})

export const _redeemWithAvatar = internalMutation({
  args: {
    ...redeemArgs,
    subject: v.string(),
    storageId: v.id('_storage'),
    thumbStorageId: v.id('_storage'),
  },
  handler: async (ctx, { subject, storageId, thumbStorageId, ...args }) => {
    const user = await findUserBySubject(ctx, subject)
    if (!user) error('Profile not initialized', 409)
    return Shares.redeemInvite(
      { ...ctx, subject, userId: user._id, role: user.role },
      args,
      { storageId, thumbStorageId },
    )
  },
})
