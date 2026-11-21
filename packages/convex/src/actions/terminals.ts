'use node'

import { v } from 'convex/values'

import { action, internalAction } from '../_generated/server'
import {
  terminalKillArgsValidator,
  terminalPollArgsValidator,
  terminalResizeArgsValidator,
  terminalSessionArgsValidator,
  terminalWriteArgsValidator,
} from '../validators/shell'

export const write = action({
  args: terminalWriteArgsValidator.fields,
  handler: async (ctx, args) =>
    (await import('../model/shell/terminalActions')).write(ctx, args),
})

export const kill = action({
  args: terminalKillArgsValidator.fields,
  handler: async (ctx, args) =>
    (await import('../model/shell/terminalActions')).kill(ctx, args),
})

export const resize = action({
  args: terminalResizeArgsValidator.fields,
  handler: async (ctx, args) =>
    (await import('../model/shell/terminalActions')).resize(ctx, args),
})

export const background = action({
  args: terminalKillArgsValidator.fields,
  handler: async (ctx, args) =>
    (await import('../model/shell/terminalActions')).background(ctx, args),
})

export const list = action({
  args: terminalSessionArgsValidator.fields,
  handler: async (ctx, args) =>
    (await import('../model/shell/terminalActions')).list(ctx, args),
})

export const poll = action({
  args: terminalPollArgsValidator.fields,
  handler: async (ctx, args) =>
    (await import('../model/shell/terminalActions')).poll(ctx, args),
})

export const killAll = action({
  args: terminalSessionArgsValidator.fields,
  handler: async (ctx, args) =>
    (await import('../model/shell/terminalActions')).killAll(ctx, args),
})

export const _killSessionJobs = internalAction({
  args: {
    sessionId: v.id('sessions'),
    owner: v.string(),
    includeBackground: v.optional(v.boolean()),
  },
  handler: async (ctx, args) =>
    (await import('../model/shell/terminalActions'))._killSessionJobs(
      ctx,
      args,
    ),
})
