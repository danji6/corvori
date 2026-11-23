type LocalStorageObject = Record<string, unknown>
type Update<T> = (current: T) => Partial<T>

function parseObject<T extends LocalStorageObject>(raw: string | null): T {
  try {
    const value: unknown = raw === null ? null : JSON.parse(raw)
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as T
    }
  } catch {
    // Treat invalid records as empty.
  }
  return {} as T
}

export function createLocalStorageStore<T extends LocalStorageObject>(
  key: string,
) {
  let cache = {} as T
  let saved: string | null | undefined
  let memoryOnly = false
  const listeners = new Set<() => void>()

  function emit() {
    listeners.forEach((listener) => listener())
  }

  function refresh() {
    if (memoryOnly || typeof window === 'undefined') return
    try {
      const raw = window.localStorage.getItem(key)
      if (raw === saved) return
      const next = parseObject<T>(raw)
      const fields = next as LocalStorageObject
      for (const field of Object.keys(next)) {
        if (JSON.stringify(cache[field]) === JSON.stringify(fields[field])) {
          fields[field] = cache[field]
        }
      }
      saved = raw
      cache = next
    } catch {
      // Retain the last usable snapshot if storage is inaccessible.
    }
  }

  function onStorage(event: StorageEvent) {
    if (event.key !== key && event.key !== null) return
    try {
      if (event.storageArea && event.storageArea !== window.localStorage) return
    } catch {
      return
    }
    const previous = cache
    refresh()
    if (cache !== previous) emit()
  }

  function subscribe(listener: () => void) {
    if (listeners.size === 0 && typeof window !== 'undefined') {
      window.addEventListener('storage', onStorage)
      refresh()
    }
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0 && typeof window !== 'undefined') {
        window.removeEventListener('storage', onStorage)
      }
    }
  }

  function persist(next: T) {
    try {
      const data = JSON.stringify(next)
      if (data === saved && !memoryOnly) return
      cache = next
      window.localStorage.setItem(key, data)
      saved = data
      memoryOnly = false
    } catch {
      cache = next
      memoryOnly = true
    }
  }

  function update(change: Update<T>) {
    const previous = cache
    refresh()
    const next = { ...cache }
    let changed = false
    for (const [field, value] of Object.entries(change(cache))) {
      if (Object.is(cache[field], value)) continue
      if (value === undefined) delete next[field]
      else (next as LocalStorageObject)[field] = value
      changed = true
    }
    if (changed) persist(next)
    if (cache !== previous) emit()
  }

  return {
    get: () => {
      if (listeners.size === 0) refresh()
      return cache
    },
    subscribe,
    update,
    set: (patch: Partial<T>) => update(() => patch),
  }
}

/** Returns a stable store for each account and storage key. */
export function createAccountLocalStorage<T extends LocalStorageObject>(
  key: string,
) {
  const stores = new Map<
    string,
    ReturnType<typeof createLocalStorageStore<T>>
  >()
  return (userId: string) => {
    let store = stores.get(userId)
    if (!store) {
      store = createLocalStorageStore<T>(`${key}:${userId}`)
      stores.set(userId, store)
    }
    return store
  }
}
