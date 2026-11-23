import { CONTEXT_NOTE_TYPES } from '@cv/core/context-notes'
import { hasInterpolation, parse } from '@cv/core/interpreter/parse'
import {
  limitPreview,
  readMarkdownPreview,
} from '@cv/core/utils/markdown-preview'
import { settleUnansweredToolPart } from '@cv/core/utils/tool-parts'
import type { UIMessage } from 'ai'
import type { FilterBuilder, NamedTableInfo } from 'convex/server'

import { internal } from '../_generated/api'
import type { DataModel, Doc, Id } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'

const PREVIEW_LENGTH = 140

/**
 * Schedules title resolution for a session that has no title yet. The action
 * generates one with the configured title model, or falls back to a
 * truncated first message otherwise.
 */
export async function scheduleTitle(
  ctx: MutationCtx,
  sessionId: Id<'sessions'>,
  assistantText?: string,
) {
  const session = await ctx.db.get(sessionId)
  if (!session || hasSavedTitle(session)) return

  if (session.titleGenerationJobId) {
    const job = await ctx.db.system.get(
      '_scheduled_functions',
      session.titleGenerationJobId,
    )
    if (job?.state.kind === 'pending' || job?.state.kind === 'inProgress')
      return
  }

  const titleGenerationJobId = await ctx.scheduler.runAfter(
    0,
    internal.actions.sessions._generateTitle,
    { sessionId, ...(assistantText === undefined ? {} : { assistantText }) },
  )
  await ctx.db.patch(sessionId, { titleGenerationJobId })
}

/** An explicit title save, including an empty title, takes precedence. */
export function hasSavedTitle(session: Pick<Doc<'sessions'>, 'title'>) {
  return session.title !== undefined
}

/** Updates session activity and returns the members for notification delivery. */
export async function syncActivity(
  ctx: MutationCtx,
  sessionId: Id<'sessions'>,
  content: unknown[] | string,
) {
  const now = Date.now()
  const preview =
    typeof content === 'string'
      ? limitPreview(content, PREVIEW_LENGTH) || undefined
      : messagePreview(content)

  const session = await ctx.db.get(sessionId)

  await ctx.db.patch(sessionId, {
    lastMessageAt: now,
    lastMessagePreview: preview,
    ...(preview && !session?.firstMessagePreview
      ? { firstMessagePreview: preview }
      : {}),
  })

  const members = await ctx.db
    .query('userSessions')
    .withIndex('by_sessionId', (q) => q.eq('sessionId', sessionId))
    .collect()

  for (const member of members) {
    await ctx.db.patch(member._id, { lastMessageAt: now })
  }
  return members
}

/** Builds a session preview from the visible text parts of a message. */
export function messagePreview(parts: unknown[]) {
  const text: string[] = []
  let codeFallback = ''
  for (const part of parts) {
    if (!isTextPart(part)) continue
    const { prose, code } = readMarkdownPreview(part.text)
    codeFallback ||= code
    if (prose) text.push(prose)
  }
  return (
    limitPreview(text.join(' ') || codeFallback, PREVIEW_LENGTH) || undefined
  )
}

export function textFromParts(parts: unknown[]) {
  return parts
    .filter(isTextPart)
    .map((part) => part.text)
    .join(' ')
}

export function isTextPart(
  part: unknown,
): part is { type: 'text'; text: string } {
  return (
    isMessagePartRecord(part) &&
    part.type === 'text' &&
    typeof part.text === 'string'
  )
}

const SEARCH_TEXT_LIMIT = 10_000
const TOOL_INPUT_LIMIT = 500

/**
 * Flattens a message's text parts into a single searchable string.
 * Reasoning parts and tool outputs are excluded.
 */
export function searchTextFromParts(parts: unknown[]): string {
  const segments: string[] = []

  for (const part of parts) {
    if (!isMessagePartRecord(part)) continue
    const { type } = part

    if (type === 'text' && typeof part.text === 'string') {
      segments.push(part.text)
      continue
    }

    if (typeof type === 'string' && type.startsWith('tool-')) {
      const input = toolInputText(part.input)
      if (input) segments.push(input)
    }
  }

  return segments.join('\n').slice(0, SEARCH_TEXT_LIMIT)
}

function toolInputText(input: unknown): string {
  if (typeof input === 'string') return input.slice(0, TOOL_INPUT_LIMIT)
  if (!isMessagePartRecord(input)) return ''
  if (typeof input.command === 'string') {
    return input.command.slice(0, TOOL_INPUT_LIMIT)
  }
  try {
    return JSON.stringify(input).slice(0, TOOL_INPUT_LIMIT)
  } catch {
    return ''
  }
}

export function finalizeMessageParts(parts: unknown[]) {
  return parts.map((part) => {
    if (!isMessagePartRecord(part)) return part

    if (part.state === 'streaming') {
      return { ...part, state: 'done' }
    }

    const settled = settleUnansweredToolPart(part)
    if (settled !== part) return settled

    if (part.state === 'output-available' && isMessagePartRecord(part.output)) {
      const waiting =
        part.output.status === 'running' &&
        typeof part.output.waitUntil === 'number'
      if (waiting && part.type === 'tool-shell_output') {
        const { output: _output, preliminary: _preliminary, ...base } = part
        return {
          ...base,
          state: 'output-error',
          errorText: 'Shell output wait was cancelled.',
        }
      }
      if (waiting && part.type === 'tool-shell') {
        const { waitUntil: _deadline, ...output } = part.output
        return {
          ...part,
          preliminary: undefined,
          output: finalizeRunningToolOutput(output),
        }
      }
    }

    if (
      typeof part.type === 'string' &&
      part.type.startsWith('tool-') &&
      part.state === 'output-available' &&
      part.preliminary === true
    ) {
      return {
        ...part,
        preliminary: undefined,
        output: finalizeRunningToolOutput(part.output),
      }
    }

    return part
  })
}

function finalizeRunningToolOutput(output: unknown) {
  if (!isMessagePartRecord(output) || output.status !== 'running') return output
  return { ...output, status: 'killed' }
}

export function removeEmptyAssistantMessages(messages: UIMessage[]) {
  return messages.filter((message) => !isEmptyAssistantMessage(message))
}

export function isEmptyAssistantMessage(message: UIMessage) {
  return (
    message.role === 'assistant' &&
    message.parts.every((part) => {
      if (part.type === 'text' || part.type === 'reasoning') {
        return part.text.trim().length === 0
      }
      return false
    })
  )
}

export function shouldSaveSubmittedPrompt(
  prompt: string,
  filesCount: number,
  regenerate?: boolean,
) {
  return !regenerate || prompt.trim().length > 0 || filesCount > 0
}

export function isContextEligible(parts: unknown[]) {
  return parts.length > 0
}

type MessageFilter = FilterBuilder<NamedTableInfo<DataModel, 'messages'>>

/**
 * Command chips are user-facing markers with no content. Turn logic must look
 * past them, or they read as an interjection that splits or extends a turn.
 */
export const notACommandChip = (q: MessageFilter) =>
  q.neq(q.field('type'), 'command')

/** Skips transcript markers when looking for user input or interjections. */
export const notATranscriptMarker = (q: MessageFilter) =>
  q.and(
    notACommandChip(q),
    q.neq(q.field('type'), 'contextReset'),
    q.neq(q.field('type'), 'presence'),
  )

/** Excludes prepared provider context from messages that interrupt a turn. */
export const notAContextNote = (q: MessageFilter) =>
  q.and(...CONTEXT_NOTE_TYPES.map((type) => q.neq(q.field('type'), type)))

/**
 * Reports of jobs the user stopped by hand are transcript records only. Turn
 * logic must look past them, or a manual stop reads as an event to react to.
 */
export const notAUserKilledReport = (q: MessageFilter) =>
  q.neq(q.field('extra.userKilled'), true)

export function hasMessageScript(text: string) {
  if (!hasInterpolation(text)) return false
  return parse(text).some((segment) => segment.type !== 'literal')
}

export function partsHaveScript(parts: unknown[]): boolean {
  return parts.some(isUnevaluatedTextPart)
}

export function isUnevaluatedTextPart(
  part: unknown,
): part is { type: 'text'; text: string } {
  return (
    isTextPart(part) &&
    !('evaluationRendered' in part && part.evaluationRendered === true) &&
    hasMessageScript(part.text)
  )
}

export function withoutUnevaluatedText(parts: unknown[]) {
  return parts.filter(
    (part) => !isUnevaluatedTextPart(part) && !isEvaluationPlaceholder(part),
  )
}

export function isEvaluationPlaceholder(part: unknown): boolean {
  return (
    isTextPart(part) &&
    'evaluationPending' in part &&
    part.evaluationPending === true
  )
}

export function replaceEvaluationPlaceholders(parts: unknown[], text: string) {
  return parts.map((part) =>
    isEvaluationPlaceholder(part) ? { type: 'text', text } : part,
  )
}

export function stripMessageError(metadata: Doc<'messages'>['metadata']) {
  if (!metadata?.error) return metadata

  const { error: _error, ...rest } = metadata
  return Object.keys(rest).length > 0 ? rest : undefined
}

function isMessagePartRecord(part: unknown): part is Record<string, unknown> {
  return typeof part === 'object' && part !== null && !Array.isArray(part)
}
