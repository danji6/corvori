import { uiSettingsStore } from '../ui-settings'

const MAX_RECENT_DIRECTORIES = 10
const EMPTY_DIRECTORIES: string[] = []

export function getRecentDirectories(userId: string): string[] {
  return uiSettingsStore(userId).get().recentDirectories ?? EMPTY_DIRECTORIES
}

export function clearRecentDirectories(userId: string) {
  uiSettingsStore(userId).set({ recentDirectories: undefined })
}

/** Remembers a confirmed directory, placing it before earlier selections. */
export function rememberDirectory(userId: string, path: string) {
  uiSettingsStore(userId).update(({ recentDirectories = [] }) => ({
    recentDirectories: [
      path,
      ...recentDirectories.filter((item) => item !== path),
    ].slice(0, MAX_RECENT_DIRECTORIES),
  }))
}
