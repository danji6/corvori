import { createAccountLocalStorage } from '../local-storage-store'
import { boundedEntryPatch } from './bounded-entries'

type Draft = { text: string; updatedAt: number }
type Drafts = Record<string, Draft | undefined>
const MAX_ENTRIES = 100

/** Retains the 100 most recent drafts per user, plus an optional protected draft. */
export function createTextDraftStore(
  storageKey: string,
  protectedKey?: string,
) {
  const accountStore = createAccountLocalStorage<Drafts>(storageKey)
  return (userId: string) => {
    const store = accountStore(userId)
    const clear = (key: string) => store.set({ [key]: undefined })
    return {
      read: (key: string) => store.get()[key]?.text ?? '',
      clear,
      write(key: string, text: string) {
        if (!text.trim()) {
          clear(key)
          return
        }
        const entry = { text, updatedAt: Date.now() }
        store.update((current) =>
          boundedEntryPatch(current, key, entry, MAX_ENTRIES, protectedKey),
        )
      },
    }
  }
}
