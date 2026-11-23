import { v } from 'convex/values'

import { internalMutation } from './_generated/server'
import { authQuery } from './functions'
import * as Avatars from './model/avatars'
import {
  discardJoinAvatarFiles,
  sweepJoinAvatarFiles,
} from './model/avatars/joinStorage'

export const getUrls = authQuery({
  args: { avatarId: v.id('avatars') },
  handler: (ctx, { avatarId }) => Avatars.getUrls(ctx, avatarId),
})

export const getUrlMap = authQuery({
  args: { ids: v.array(v.id('avatars')) },
  handler: Avatars.getUrlMap,
})

export const _create = internalMutation({
  args: { storageId: v.id('_storage'), thumbStorageId: v.id('_storage') },
  handler: (ctx, args) => Avatars._create(ctx, args),
})

export const _discardJoinFiles = internalMutation({
  args: { ids: v.array(v.id('_storage')) },
  handler: discardJoinAvatarFiles,
})

export const _sweepJoinFiles = internalMutation({
  args: { cursor: v.optional(v.string()), cutoff: v.optional(v.number()) },
  handler: sweepJoinAvatarFiles,
})
