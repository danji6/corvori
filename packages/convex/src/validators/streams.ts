import { type Infer, v } from 'convex/values'

import {
  cacheDiagnosticValidator,
  providerContinuityScopeValidator,
  providerContinuityValidator,
  providerContinuityValueValidator,
} from './providerRequests'
import { tokenUsageValidator } from './providers'
import { sessionModeValidator } from './sessionModes'
import { saveSessionCacheArgsValidator } from './sessions'
import { toolManifestValidator } from './tools'

const skillAvailabilityValidator = v.object({ skills: v.boolean() })

export const streamStatusValidator = v.union(
  v.literal('pending'),
  v.literal('awaiting_attachments'),
  v.literal('streaming'),
  v.literal('stopping'),
  v.literal('retrying'),
  v.literal('awaiting_approval'),
  v.literal('awaiting_input'),
)

/** A parked yield call waiting for people to confirm who responds next. */
export const yieldRequestValidator = v.object({
  toolCallId: v.string(),
  targetAgentId: v.id('agents'),
  /** When the request is accepted on its own; unset once someone paused it. */
  fireAt: v.optional(v.number()),
  jobId: v.optional(v.id('_scheduled_functions')),
})

export type YieldRequest = Infer<typeof yieldRequestValidator>

export const yieldRequestViewValidator = v.object({
  toolCallId: v.string(),
  targetAgentId: v.id('agents'),
  fireAt: v.optional(v.number()),
})

export const resolveYieldArgsValidator = v.object({
  sessionId: v.id('sessions'),
  toolCallId: v.string(),
  /** Overrides the requested agent. */
  agentId: v.optional(v.id('agents')),
})

export type ResolveYieldArgs = Infer<typeof resolveYieldArgsValidator>

export const yieldRequestArgsValidator = v.object({
  sessionId: v.id('sessions'),
  toolCallId: v.string(),
})

export type YieldRequestArgs = Infer<typeof yieldRequestArgsValidator>

/** Exposes chat controls without coupling clients to persisted execution data. */
export const activeStreamValidator = v.object({
  _id: v.id('streams'),
  invokedBy: v.id('users'),
  status: streamStatusValidator,
  generation: v.number(),
  attempt: v.number(),
  processingMessageId: v.optional(v.id('messages')),
  fireAt: v.optional(v.number()),
  retryAt: v.optional(v.number()),
  retryError: v.optional(v.string()),
  yield: v.optional(yieldRequestViewValidator),
})

export type ActiveStream = Infer<typeof activeStreamValidator>

export const streamCommandValidator = v.union(
  v.object({
    kind: v.literal('invoke'),
    mode: v.optional(sessionModeValidator),
    preserveContextBoundary: v.optional(v.boolean()),
    skipThresholdCompaction: v.optional(v.boolean()),
  }),
  v.object({
    kind: v.literal('compact'),
    instructions: v.optional(v.string()),
    preserveContextBoundary: v.optional(v.boolean()),
    followUpAfterCompact: v.optional(v.boolean()),
    autoCompact: v.optional(v.boolean()),
    thresholdResume: v.optional(
      v.object({
        mode: v.optional(sessionModeValidator),
        omitActiveMedia: v.optional(v.boolean()),
      }),
    ),
  }),
  v.object({
    kind: v.literal('impersonate'),
    instructions: v.optional(v.string()),
  }),
  v.object({
    kind: v.literal('retry'),
    previousVersion: v.number(),
    mode: v.optional(sessionModeValidator),
  }),
)

export type StreamCommand = Infer<typeof streamCommandValidator>

const optionalOutput = {
  processingMessageId: v.optional(v.id('messages')),
  processingContentId: v.optional(v.id('messageContents')),
}
const requiredOutput = {
  processingMessageId: v.id('messages'),
  processingContentId: v.optional(v.id('messageContents')),
}

/** Stores only the data owned by the current lifecycle phase. */
export const streamStateValidator = v.union(
  v.object({ phase: v.literal('reserved'), ...optionalOutput }),
  v.object({
    phase: v.literal('awaiting_attachments'),
    fireAt: v.optional(v.number()),
    ...optionalOutput,
  }),
  v.object({
    phase: v.literal('pending'),
    jobId: v.id('_scheduled_functions'),
    fireAt: v.optional(v.number()),
    ...optionalOutput,
  }),
  v.object({ phase: v.literal('streaming'), ...requiredOutput }),
  v.object({
    phase: v.literal('retrying'),
    jobId: v.id('_scheduled_functions'),
    retryAt: v.number(),
    retryError: v.string(),
    ...requiredOutput,
  }),
  v.object({ phase: v.literal('awaiting_approval'), ...requiredOutput }),
  v.object({
    phase: v.literal('awaiting_input'),
    yield: v.optional(yieldRequestValidator),
    ...requiredOutput,
  }),
  v.object({
    phase: v.literal('stopping'),
    retryError: v.optional(v.string()),
    ...optionalOutput,
  }),
)

export type StreamState = Infer<typeof streamStateValidator>

export const streamExecutionArgsValidator = v.object({
  streamId: v.id('streams'),
  generation: v.number(),
})

export type StreamExecutionArgs = Infer<typeof streamExecutionArgsValidator>

export const stopStreamArgsValidator = v.object({
  sessionId: v.id('sessions'),
  execution: v.optional(streamExecutionArgsValidator),
})

export type StopStreamArgs = Infer<typeof stopStreamArgsValidator>

export const providerHistorySnapshotArgsValidator = v.object({
  ...streamExecutionArgsValidator.fields,
  knownHistory: v.optional(v.string()),
})

export type ProviderHistorySnapshotArgs = Infer<
  typeof providerHistorySnapshotArgsValidator
>

export const patchStreamMessageArgsValidator = v.object({
  ...streamExecutionArgsValidator.fields,
  parts: v.array(v.any()),
})

export type PatchStreamMessageArgs = Infer<
  typeof patchStreamMessageArgsValidator
>

export const recordStreamStepArgsValidator = v.object({
  ...streamExecutionArgsValidator.fields,
  interruptible: v.boolean(),
})

export type RecordStreamStepArgs = Infer<typeof recordStreamStepArgsValidator>

export const failStreamArgsValidator = v.object({
  ...streamExecutionArgsValidator.fields,
  message: v.string(),
})

export type FailStreamArgs = Infer<typeof failStreamArgsValidator>

export const trackStreamOutputArgsValidator = v.object({
  ...streamExecutionArgsValidator.fields,
  messageId: v.id('messages'),
  storageId: v.id('_storage'),
})

export type TrackStreamOutputArgs = Infer<typeof trackStreamOutputArgsValidator>

export const saveStreamMetaArgsValidator = v.object({
  ...streamExecutionArgsValidator.fields,
  duration: v.number(),
  toolErrors: v.array(v.string()),
  warnings: v.array(v.string()),
  usage: tokenUsageValidator,
  providerRequestId: v.optional(v.string()),
  titleText: v.optional(v.string()),
})

export type SaveStreamMetaArgs = Infer<typeof saveStreamMetaArgsValidator>

export const scheduleStreamRetryArgsValidator = v.object({
  ...streamExecutionArgsValidator.fields,
  retryAt: v.number(),
  retryError: v.string(),
})

export type ScheduleStreamRetryArgs = Infer<
  typeof scheduleStreamRetryArgsValidator
>

/** A leased background turn, including retries and deferred work. */
export const streamSchema = v.object({
  promptEvaluationId: v.optional(v.id('promptEvaluations')),
  taskRunId: v.optional(v.id('scheduledTaskRuns')),
  generation: v.number(),
  providerContinuity: v.optional(providerContinuityValidator),
  changeGroupId: v.optional(v.string()),
  sessionId: v.id('sessions'),
  agentId: v.id('agents'),
  invokedBy: v.id('users'),
  command: streamCommandValidator,
  state: streamStateValidator,
  contextBoundaryMessageId: v.optional(v.id('messages')),
  contextBoundaryCreationTime: v.optional(v.number()),
  /** A pending attachment send arrived after this turn took its input. */
  deferInterjections: v.optional(v.boolean()),
  attempt: v.number(),
  leaseExpiresAt: v.number(),
  /** A stop to honor after the current provider step. */
  stopAt: v.optional(v.number()),
  /** Skip this turn’s media payloads in model requests after a provider rejection. */
  omitActiveMedia: v.optional(v.boolean()),
  skillCatalogSource: v.optional(v.string()),
  skillAvailability: v.optional(skillAvailabilityValidator),
  skillContextPrepared: v.optional(v.boolean()),
  skillToolkitFingerprint: v.optional(v.string()),
  skillContextMessageId: v.optional(v.id('messages')),
  workspaceContextPrepared: v.optional(v.boolean()),
  workspaceContextMessageId: v.optional(v.id('messages')),
  mcpContextFingerprint: v.optional(v.string()),
  mcpContextMessageId: v.optional(v.id('messages')),
  suppressFollowUp: v.optional(v.boolean()),
  /** True for child (sub-agent) streams stopped from above. */
  suppressReport: v.optional(v.boolean()),
})

export const saveStreamCacheArgsValidator = v.object({
  ...saveSessionCacheArgsValidator.fields,
  ...streamExecutionArgsValidator.fields,
})

export type SaveStreamCacheArgs = Infer<typeof saveStreamCacheArgsValidator>

export const compactAtThresholdArgsValidator = v.object({
  ...streamExecutionArgsValidator.fields,
  modelId: v.string(),
  contextWindow: v.number(),
  environment: v.optional(v.record(v.string(), v.any())),
})

export type ThresholdCompactionArgs = Infer<
  typeof compactAtThresholdArgsValidator
>

export const saveStreamLogArgsValidator = v.object({
  ...streamExecutionArgsValidator.fields,
  storageId: v.id('_storage'),
})

export type SaveStreamLogArgs = Infer<typeof saveStreamLogArgsValidator>

export const prepareCapabilitiesArgsValidator = v.object({
  ...streamExecutionArgsValidator.fields,
  source: v.string(),
  manifest: toolManifestValidator,
  contextId: v.string(),
  skillCatalogSource: v.optional(v.string()),
  skillAvailability: v.optional(skillAvailabilityValidator),
})

export type PrepareCapabilitiesArgs = Infer<
  typeof prepareCapabilitiesArgsValidator
>

export const assertToolAccessArgsValidator = v.object({
  ...streamExecutionArgsValidator.fields,
  name: v.string(),
  manifest: toolManifestValidator,
})

export type AssertToolAccessArgs = Infer<typeof assertToolAccessArgsValidator>

export const prepareContextNoteArgsValidator = v.object({
  sessionFiles: v.optional(v.boolean()),
  contextId: v.optional(v.string()),
  capabilities: v.optional(v.array(v.string())),
  ...streamExecutionArgsValidator.fields,
  fingerprint: v.string(),
  content: v.string(),
  label: v.optional(v.string()),
  toolkitFingerprint: v.optional(v.string()),
})

export type PrepareContextNoteArgs = Infer<
  typeof prepareContextNoteArgsValidator
>

export const resolveProviderCacheIdArgsValidator = v.object({
  ...streamExecutionArgsValidator.fields,
  prefixDigest: v.string(),
})

export type ResolveProviderCacheIdArgs = Infer<
  typeof resolveProviderCacheIdArgsValidator
>

export const prepareProviderRequestArgsValidator = v.object({
  ...streamExecutionArgsValidator.fields,
  scope: providerContinuityScopeValidator,
})

export type PrepareProviderRequestArgs = Infer<
  typeof prepareProviderRequestArgsValidator
>

export const saveProviderContinuityArgsValidator = v.object({
  ...prepareProviderRequestArgsValidator.fields,
  value: v.optional(providerContinuityValueValidator),
  reset: v.boolean(),
})

export type SaveProviderContinuityArgs = Infer<
  typeof saveProviderContinuityArgsValidator
>

export const recordCacheDiagnosticArgsValidator = v.object({
  ...streamExecutionArgsValidator.fields,
  diagnostic: cacheDiagnosticValidator,
})

export type RecordCacheDiagnosticArgs = Infer<
  typeof recordCacheDiagnosticArgsValidator
>
