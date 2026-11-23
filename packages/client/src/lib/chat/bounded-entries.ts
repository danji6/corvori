/** Inserts an entry and evicts the oldest entries above the caller's limit. */
export function boundedEntryPatch<T extends { updatedAt: number }>(
  current: Record<string, T | undefined>,
  key: string,
  entry: T,
  limit: number,
  protectedKey?: string,
): Record<string, T | undefined> {
  const next = { ...current, [key]: entry }
  const keys = Object.keys(next).filter((id) => id !== protectedKey)
  const patch: Record<string, T | undefined> = { [key]: entry }
  if (keys.length > limit) {
    keys.sort((a, b) => (next[a]?.updatedAt ?? 0) - (next[b]?.updatedAt ?? 0))
    for (const stale of keys.slice(0, keys.length - limit))
      patch[stale] = undefined
  }
  return patch
}
