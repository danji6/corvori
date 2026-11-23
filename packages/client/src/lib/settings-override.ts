import { type SettingsOverride, uiSettingsStore } from './ui-settings'

export type { SettingsOverride } from './ui-settings'

const EMPTY_OVERRIDE: SettingsOverride = {}

export function getSettingsOverride(userId: string): SettingsOverride {
  return uiSettingsStore(userId).get().fonts ?? EMPTY_OVERRIDE
}

export function setSettingsOverride(
  userId: string,
  fonts: SettingsOverride | undefined,
) {
  uiSettingsStore(userId).set({ fonts })
}
