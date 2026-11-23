/** Applies expansion choices in action order, including defaults for unloaded descendants. */
export function isFolderCollapsed(
  state: Record<string, boolean>,
  id: string,
  ancestorIds: string[] = [],
) {
  const keys = new Set([
    '*',
    id,
    ...ancestorIds.map((ancestor) => `branch:${ancestor}`),
  ])
  let collapsed = true
  for (const [key, value] of Object.entries(state)) {
    if (keys.has(key)) collapsed = value
  }
  return collapsed
}

/** Records a new choice after earlier inherited and individual choices. */
export function setFolderCollapsed(
  state: Record<string, boolean>,
  key: string,
  value: boolean,
) {
  const next = { ...state }
  delete next[key]
  next[key] = value
  return next
}
