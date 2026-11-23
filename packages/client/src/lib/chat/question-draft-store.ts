import { APP_ID } from '@cv/core/const'

import { createAccountLocalStorage } from '../local-storage-store'
import { boundedEntryPatch } from './bounded-entries'

const STORAGE_KEY = `${APP_ID}-question-drafts`
const MAX_ENTRIES = 100

export type AnswerDraft = {
  selectedOptionIndices: number[]
  customAnswer: string
  note: string
  skipped: boolean
}

export type QuestionDraft = {
  questionIndex: number
  answers: AnswerDraft[]
}

type StoredDraft = QuestionDraft & { updatedAt: number }
type StoredDrafts = Record<string, StoredDraft>

const store = createAccountLocalStorage<StoredDrafts>(STORAGE_KEY)

/** Namespaces a picker draft to one session and tool call. */
export function questionDraftKey(sessionId: string, toolCallId: string) {
  return `${sessionId}:${toolCallId}`
}

/** Reads a persisted picker draft, ignoring malformed response containers. */
export function getQuestionDraft(
  userId: string,
  key: string,
): QuestionDraft | null {
  const value = store(userId).get()[key]
  if (!value || !Array.isArray(value.answers)) return null
  return { questionIndex: value.questionIndex, answers: value.answers }
}

/** Persists a draft and evicts the oldest entries over the storage cap. */
export function setQuestionDraft(
  userId: string,
  key: string,
  draft: QuestionDraft,
) {
  const entry = { ...draft, updatedAt: Date.now() }
  store(userId).update((current) =>
    boundedEntryPatch(current, key, entry, MAX_ENTRIES),
  )
}

/** Removes a settled or aborted tool call's picker draft. */
export function clearQuestionDraft(userId: string, key: string) {
  store(userId).set({ [key]: undefined } as Partial<StoredDrafts>)
}
