import { useAccountId } from '@/hooks/account-scope'
import { APP_ID } from '@cv/core/const'
import { useEffect, useMemo } from 'react'

import { createAccountLocalStorage } from '../local-storage-store'
import { debounce } from '../utils'
import { boundedEntryPatch } from './bounded-entries'
import { draftRestoreFor } from './draft-restore'

const STORAGE_KEY = `${APP_ID}-editor-drafts`

/** How many editors retain an unsaved draft before the oldest is evicted. */
const MAX_ENTRIES = 50

/** Autosave debounce for the prompt, reminder and script editors. */
const SAVE_DEBOUNCE_MS = 300

type Entry = { value: unknown; updatedAt: number }

type Drafts = Record<string, Entry>

const store = createAccountLocalStorage<Drafts>(STORAGE_KEY)

/** Draft key for a prompt editor. */
export function promptDraftKey(promptId: string): string {
  return `prompt:${promptId}`
}

/** Draft key for a reminder editor. */
export function reminderDraftKey(reminderId: string): string {
  return `reminder:${reminderId}`
}

/** Draft key for a session's plan editor. */
export function planDraftKey(sessionId: string): string {
  return `plan:${sessionId}`
}

/** Draft key for the script manager, which edits one list at a time. */
export const SCRIPTS_DRAFT_KEY = 'scripts'

/** Draft key for one agent's settings form. */
export function agentSettingsDraftKey(agentId: string): string {
  return `agent-settings:${agentId}`
}

/** Draft key for the user settings form, of which there is only one. */
export const USER_SETTINGS_DRAFT_KEY = 'user-settings'

/** Draft key for the agent being created, independent of database IDs. */
export const NEW_AGENT_DRAFT_KEY = 'new-agent'

export function getEditorDraft<T>(userId: string, key: string): T | undefined {
  return store(userId).get()[key]?.value as T | undefined
}

export function setEditorDraft<T>(userId: string, key: string, value: T): void {
  const entry: Entry = { value, updatedAt: Date.now() }
  store(userId).update((current) =>
    boundedEntryPatch(current, key, entry, MAX_ENTRIES),
  )
}

export function clearEditorDraft(userId: string, key: string): void {
  store(userId).set({ [key]: undefined } as Partial<Drafts>)
}

export type EditorDraft<T> = {
  /** Current persisted draft, or undefined when there is none. */
  read: () => T | undefined
  /** Debounced autosave. */
  save: (value: T) => void
  /** Persist immediately, cancelling any pending autosave. */
  flush: (value: T) => void
  /** Drop the draft and cancel any pending autosave. */
  clear: () => void
  /**
   * Drop the draft because the editor has come back to what is stored.
   * Ignored while the draft confirmation is still pending.
   */
  clearUnchanged: () => void
  /** Asks the user before handing a stored draft to `apply`. */
  restore: (apply: (value: T) => void) => void
}

export function useEditorDraft<T>(
  key: string | undefined,
  /** Names the draft in the confirmation: "unsaved changes to <label>". */
  label: string,
): EditorDraft<T> {
  const userId = useAccountId()
  const restoreQueue = draftRestoreFor(userId)
  const debouncedSave = useMemo(
    () =>
      debounce(
        (id: string, value: unknown) => setEditorDraft(userId, id, value),
        SAVE_DEBOUNCE_MS,
      ),
    [userId],
  )

  useEffect(() => {
    if (key) restoreQueue.keepDraftRestore(key)
    return () => {
      debouncedSave.cancel()
      if (key) restoreQueue.releaseDraftRestore(key)
    }
  }, [key, debouncedSave, restoreQueue])

  return useMemo(
    () => ({
      read: () => (key ? getEditorDraft<T>(userId, key) : undefined),
      save: (value) => {
        if (key) debouncedSave(key, value)
      },
      flush: (value) => {
        debouncedSave.cancel()
        if (key) setEditorDraft(userId, key, value)
      },
      clear: () => {
        debouncedSave.cancel()
        if (key) clearEditorDraft(userId, key)
      },
      clearUnchanged: () => {
        if (!key || restoreQueue.isDraftPending(key)) return
        debouncedSave.cancel()
        clearEditorDraft(userId, key)
      },
      restore: (apply) => {
        const saved = key ? getEditorDraft<T>(userId, key) : undefined
        if (!key || saved === undefined) return
        restoreQueue.requestDraftRestore({
          key,
          label,
          apply: () => apply(saved),
          discard: () => {
            debouncedSave.cancel()
            clearEditorDraft(userId, key)
          },
        })
      },
    }),
    [key, label, debouncedSave, restoreQueue, userId],
  )
}
