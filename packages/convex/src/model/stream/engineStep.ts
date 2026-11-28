'use node'

import { truncateTitleExcerpt } from '@cv/core/title-generation'
import { hasPendingQuestions } from '@cv/core/utils/ask'
import { hasPendingYield } from '@cv/core/utils/yield'
import type { UIMessage } from 'ai'

import { internal } from '../../_generated/api'
import type { ActionCtx } from '../../_generated/server'
import { sanitizeChatError } from '../../errors'
import { hasPendingTaskParts } from '../../lib/subagent'
import type { StreamExecutionArgs } from '../../validators/streams'
import { hasMessageScript } from '../messages'
import {
  attachWireCalls,
  dispatchLanguageModel,
  replayLanguageModel,
} from '../tool/dispatchTransport'
import { hasAwaitingApproval } from './engineApproval'
import { attachApprovalPreviews } from './engineApproval'
import { buildSessionLogBody } from './engineLog'
import { patchSessionLogBody } from './engineLog'
import { offloadLargeParts } from './engineOutput'
import { createStreamPatcher } from './enginePatches'
import type { PreparedStreamStep } from './engineSetup'
import { STEP_DEADLINE_GRACE_MS } from './engineWatchdog'
import { STEP_DEADLINE_REASON } from './engineWatchdog'
import { watchForStop } from './engineWatchdog'
import {
  collectRespondedApprovalNotes,
  insertApprovalNoteMessages,
} from './history'
import { assertProviderStepOutput, hasReplayableToolOutputSince } from './retry'
import { toolStateSignature, withoutFileImageBytes } from './toolOutput'
import { stopWhenInactive } from './transformers'
import { resolveUsage } from './usage'

export class ProviderStreamFailure {
  constructor(
    readonly error: unknown,
    readonly hasOutput: boolean,
    readonly hasReplayableToolOutput: boolean,
    readonly aborted: boolean,
    readonly deadlineHit: boolean,
  ) {}
}

export async function consumeProviderStep(
  ctx: ActionCtx,
  execution: StreamExecutionArgs,
  setup: PreparedStreamStep,
  windowDeadline: number,
) {
  const [
    {
      InvalidToolInputError,
      readUIMessageStream,
      stepCountIs,
      streamText,
      toUIMessageStream,
    },
    {
      deduplicateToolCallIds,
      omitLargeStrings,
      formatStreamWarnings,
      normalizeUnsupportedWarnings,
      stripProviderMetadata,
      trackGeneratedOutput,
      trackToolErrors,
    },
    { repairToolCall },
    { shellApprovalPolicy },
    { applyReasoningDurations, createReasoningTracker, trackReasoningTimings },
  ] = await Promise.all([
    import('ai'),
    import('./transformers'),
    import('../tool/repair'),
    import('../tool/shellApproval'),
    import('./reasoning'),
  ])

  const outputTracker = { hasOutput: false }
  const toolErrorTracker = { toolErrors: new Set<string>() }
  const reasoningTracker = createReasoningTracker()
  const offloadCache = new Map<string, unknown>()
  const fileCache = new Map<string, unknown>()
  const abortController = new AbortController()

  const stopWatcher = watchForStop(ctx, execution, abortController, {
    deadlineAt: windowDeadline + STEP_DEADLINE_GRACE_MS,
  })

  const initialMessage = {
    id: setup.output._id,
    role: setup.output.role,
    parts: setup.output.parts as UIMessage['parts'],
  } satisfies UIMessage

  const initialPartCount = initialMessage.parts.length
  const respondedApprovalNotes = collectRespondedApprovalNotes(
    initialMessage.parts,
  )
  const command = setup.stream.command
  const toolsDisabled = command.kind === 'compact' || command.kind === 'impersonate' // prettier-ignore
  const runtime = toolsDisabled ? undefined : setup.toolRuntime
  const tools = toolsDisabled ? undefined : setup.tools

  /** Everything a parts array needs before it can be persisted. */
  const prepareParts = async (parts: UIMessage['parts']) =>
    applyReasoningDurations(
      await offloadLargeParts(
        ctx,
        runtime ? attachWireCalls(parts, runtime) : parts,
        {
          toolCache: offloadCache,
          fileCache,
          ...execution,
          messageId: setup.output._id,
          sessionId: setup.stream.sessionId,
          uploaderId: setup.stream.invokedBy,
        },
      ),
      reasoningTracker,
      initialPartCount,
    )

  let streamError: unknown
  let latestParts = initialMessage.parts
  let lastToolStates = toolStateSignature(latestParts)
  let hasPatchedText = false
  const patches = createStreamPatcher(
    async (parts) => patchMessage(ctx, execution, await prepareParts(parts)),
    abortController,
  )
  const startedAt = Date.now()
  const stopped = () => ({
    shouldContinue: null,
    hasOutput: {
      value: outputTracker.hasOutput,
      duration: Date.now() - startedAt,
      toolErrors: [...toolErrorTracker.toolErrors],
      warnings: [],
    },
  })
  try {
    const model = toolsDisabled
      ? await replayLanguageModel(
          setup.resolved.languageModel,
          setup.toolReplay,
        )
      : runtime
        ? await dispatchLanguageModel(setup.resolved.languageModel, runtime)
        : setup.resolved.languageModel
    const result = streamText({
      model,
      system: setup.systemPrompt,
      allowSystemInMessages: true,
      messages: setup.messages,
      tools: tools && Object.keys(tools).length ? tools : undefined,
      toolChoice: setup.toolChoice,
      toolApproval: tools ? shellApprovalPolicy(tools) : undefined,
      stopWhen: stepCountIs(1),
      // Approved tools execute before the first provider call. Add their notes
      // once the SDK tool results exist, without disrupting the resume.
      prepareStep: toolsDisabled
        ? undefined
        : ({ messages }) => ({
            messages: insertApprovalNoteMessages(
              messages,
              respondedApprovalNotes,
            ),
          }),
      maxRetries: 0,
      maxOutputTokens: setup.outputTokens,
      providerOptions: setup.resolved.providerOptions,
      reasoning: setup.resolved.reasoning,
      temperature: setup.resolved.temperature,
      topP: setup.resolved.topP,
      frequencyPenalty: setup.resolved.frequencyPenalty,
      presencePenalty: setup.resolved.presencePenalty,
      abortSignal: abortController.signal,
      onError: ({ error }) => {
        streamError ??= error
      },
      experimental_repairToolCall: tools
        ? async ({ toolCall, error }) =>
            InvalidToolInputError.isInstance(error)
              ? repairToolCall(toolCall)
              : null
        : undefined,
      experimental_transform: [
        normalizeUnsupportedWarnings,
        stripProviderMetadata,
        deduplicateToolCallIds,
        trackGeneratedOutput(outputTracker),
        trackToolErrors(toolErrorTracker),
        trackReasoningTimings(reasoningTracker),
        stopWhenInactive(abortController),
      ],
    })

    for await (const message of readUIMessageStream({
      message: initialMessage,
      stream: toUIMessageStream({
        stream: result.stream,
        tools,
        // Recoverable errors
        onError: (error) => sanitizeChatError(error),
      }),
      terminateOnError: true,
      onError: (error) => {
        streamError ??= error
      },
    })) {
      latestParts = message.parts
      // Publish approval requests only after path details and previews are attached
      if (hasAwaitingApproval(latestParts)) continue
      // Tool state transitions bypass the throttle to avoid staleness
      const toolStates = toolStateSignature(latestParts)
      const firstText: boolean =
        !hasPatchedText &&
        latestParts.some(
          (part, index) =>
            index >= initialPartCount &&
            part.type === 'text' &&
            part.text.length > 0,
        )
      const write = patches.update(
        latestParts,
        firstText || toolStates !== lastToolStates,
      )
      hasPatchedText ||= firstText
      lastToolStates = toolStates
      if (write) await write
      if (patches.rejected || patches.failure) break
    }

    const duration = Date.now() - startedAt
    await patches.close()
    if (patches.rejected) return stopped()
    if (patches.failure) throw patches.failure.error

    if (abortController.signal.reason === STEP_DEADLINE_REASON) {
      throw new Error('Backend execution window elapsed')
    }
    if (streamError !== undefined) throw streamError

    latestParts = await prepareParts(latestParts)
    const awaitingApproval = hasAwaitingApproval(latestParts)
    const awaitingQuestions = hasPendingQuestions(latestParts)
    const awaitingTasks = hasPendingTaskParts(latestParts)
    const awaitingYield = hasPendingYield(latestParts)
    if (awaitingApproval) {
      latestParts = await attachApprovalPreviews(ctx, setup, latestParts)
    }
    await patchMessage(ctx, execution, latestParts)

    const outputText = latestParts
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('')

    const usage = await resolveUsage({
      usage: await result.usage,
      outputText,
    })

    const steps = await result.steps
    const lastStep = steps.at(-1)
    const finishReason = lastStep?.finishReason

    const lastResponseBody = JSON.stringify(
      omitLargeStrings({ parts: latestParts, usage, finishReason }),
      null,
      2,
    )

    await patchSessionLogBody(ctx, {
      body: buildSessionLogBody({
        requestBody: setup.requestLog.body,
        responseBody: lastResponseBody,
      }),
      execution,
    })

    const needsSummaryText =
      command.kind === 'compact' && command.thresholdResume
    const hasExpectedOutput = needsSummaryText
      ? Boolean(lastStep?.text.trim())
      : outputTracker.hasOutput
    assertProviderStepOutput(hasExpectedOutput, finishReason)
    await setup.cacheDiagnostics?.complete(
      usage,
      lastStep?.usage,
      lastStep?.response,
    )

    const needsTitle = setup.needsTitle && finishReason !== 'error'
    const titleText =
      needsTitle && lastStep && !hasMessageScript(lastStep.text)
        ? truncateTitleExcerpt(lastStep.text.trim())
        : ''

    return {
      shouldContinue: !toolsDisabled && finishReason === 'tool-calls',
      titleText: titleText || undefined,
      awaitingApproval,
      awaitingQuestions,
      awaitingTasks,
      awaitingYield,
      hasOutput: {
        value: outputTracker.hasOutput,
        duration,
        toolErrors: [...toolErrorTracker.toolErrors],
        warnings: formatStreamWarnings((await result.warnings) ?? []),
      },
      usage,
    }
  } catch (error) {
    await patches.close()
    if (patches.rejected) return stopped()
    await setup.cacheDiagnostics?.fail(abortController.signal.aborted)
    latestParts = await prepareParts(latestParts).catch(() =>
      latestParts.map(withoutFileImageBytes),
    )

    await tryPatchMessage(ctx, execution, latestParts)

    throw new ProviderStreamFailure(
      patches.failure ? patches.failure.error : (streamError ?? error),
      outputTracker.hasOutput,
      hasReplayableToolOutputSince(latestParts, initialPartCount),
      abortController.signal.aborted,
      abortController.signal.reason === STEP_DEADLINE_REASON,
    )
  } finally {
    stopWatcher.dispose()
  }
}

export async function patchMessage(
  ctx: ActionCtx,
  execution: StreamExecutionArgs,
  parts: UIMessage['parts'],
): Promise<boolean> {
  return ctx.runMutation(internal.streams._patchMessage, {
    ...execution,
    parts,
  })
}

export async function tryPatchMessage(
  ctx: ActionCtx,
  execution: StreamExecutionArgs,
  parts: UIMessage['parts'],
) {
  try {
    await patchMessage(ctx, execution, parts)
  } catch {
    // no-op
  }
}
