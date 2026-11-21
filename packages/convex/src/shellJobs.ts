import { v } from 'convex/values'

import { internalMutation, internalQuery } from './_generated/server'
import { authQuery } from './functions'
import * as ShellJobs from './model/shell/jobs'
import * as References from './model/shell/references'
import * as Waits from './model/shell/waits'
import * as V from './validators/shell'
import { streamExecutionArgsValidator } from './validators/streams'

export const _register = internalMutation({
  args: {
    ...V.shellJobRegisterArgsValidator.fields,
    execution: v.optional(streamExecutionArgsValidator),
  },
  handler: ShellJobs.register,
})

export const _release = internalMutation({
  args: { sessionId: v.id('sessions'), jobId: v.string() },
  handler: ShellJobs.release,
})

export const _markUserKilled = internalMutation({
  args: V.shellJobUserKillArgsValidator.fields,
  handler: ShellJobs.markUserKilled,
})

export const _markAllUserKilled = internalMutation({
  args: V.shellJobSessionArgsValidator.fields,
  handler: ShellJobs.markAllUserKilled,
})

export const _beginWindow = internalMutation({
  args: V.shellJobExecutionArgsValidator.fields,
  handler: ShellJobs._beginWindow,
})

export const _carry = internalMutation({
  args: V.shellJobCarryArgsValidator.fields,
  handler: ShellJobs._carry,
})

export const _report = internalMutation({
  args: V.shellJobReportArgsValidator.fields,
  handler: ShellJobs._report,
})

export const refresh = internalMutation({
  args: {},
  handler: ShellJobs.refresh,
})

export const _bindReference = internalMutation({
  args: {
    ...V.shellReferenceArgsValidator.fields,
    ...V.shellOriginArgsValidator.fields,
  },
  handler: References.bindReference,
})

export const _findReference = internalQuery({
  args: V.shellReferenceArgsValidator.fields,
  handler: References.findReference,
})

export const reference = authQuery({
  args: V.shellReferenceArgsValidator.fields,
  handler: References.transcriptReference,
})

export const _pendingWaits = internalQuery({
  args: streamExecutionArgsValidator.fields,
  handler: Waits.pendingShellWaits,
})

export const _finishWait = internalMutation({
  args: {
    ...streamExecutionArgsValidator.fields,
    toolCallId: v.string(),
    output: v.optional(V.shellToolOutputValidator),
    errorText: v.optional(v.string()),
  },
  handler: Waits.finishShellWait,
})

export const _saveTerminal = internalMutation({
  args: { sessionId: v.id('sessions'), output: V.shellToolOutputValidator },
  handler: (ctx, { sessionId, output }) =>
    References.saveTerminal(ctx, sessionId, output),
})
