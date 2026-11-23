import { createLocalStorageStore } from '@/lib/local-storage-store'
import { afterEach, expect, test } from 'bun:test'
import { setupDom } from '~/tests/setup/dom'

setupDom()

const KEY = 'storage-test'
type Settings = {
  sidebar?: { pinned?: boolean; collapsed?: boolean }
  fonts?: { chatFont?: string }
}

afterEach(() => localStorage.clear())

test('treats malformed records and non-object JSON as empty', () => {
  for (const value of ['{', 'null', '[]', '12', '"text"']) {
    localStorage.setItem(KEY, value)
    expect(createLocalStorageStore<Settings>(KEY).get()).toEqual({})
  }
})

test('merges nested writes against current disk state and keeps unrelated slices stable', () => {
  const first = createLocalStorageStore<Settings>(KEY)
  const second = createLocalStorageStore<Settings>(KEY)
  const unsubscribe = second.subscribe(() => {})
  try {
    second.set({ fonts: { chatFont: 'Inter' } })
    const fonts = second.get().fonts
    first.set({ sidebar: { pinned: true } })
    second.update(({ sidebar }) => ({
      sidebar: { ...sidebar, collapsed: false },
    }))
    expect(first.get()).toEqual({
      fonts: { chatFont: 'Inter' },
      sidebar: { pinned: true, collapsed: false },
    })
    expect(second.get().fonts).toBe(fonts)
  } finally {
    unsubscribe()
  }
})

test('subscribers observe cross-tab clears and removals', () => {
  const store = createLocalStorageStore<Settings>(KEY)
  let snapshots = 0
  const unsubscribe = store.subscribe(() => snapshots++)
  try {
    for (const key of [KEY, null]) {
      store.set({ fonts: { chatFont: 'Inter' } })
      localStorage.removeItem(KEY)
      window.dispatchEvent(new StorageEvent('storage', { key }))
      expect(store.get()).toEqual({})
    }
    expect(snapshots).toBe(4)
  } finally {
    unsubscribe()
  }
})

test('keeps in-memory updates when browser storage cannot be accessed', () => {
  const original = Object.getOwnPropertyDescriptor(window, 'localStorage')
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    get: () => {
      throw new Error('Blocked')
    },
  })
  try {
    const store = createLocalStorageStore<Settings>(KEY)
    store.set({ sidebar: { pinned: true } })
    const snapshot = store.get()
    expect(snapshot).toEqual({ sidebar: { pinned: true } })
    expect(store.get()).toBe(snapshot)
    store.set({ fonts: { chatFont: 'Inter' } })
    expect(store.get().sidebar).toBe(snapshot.sidebar)
  } finally {
    if (original) Object.defineProperty(window, 'localStorage', original)
    else Reflect.deleteProperty(window, 'localStorage')
  }
})
