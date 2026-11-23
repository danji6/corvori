import { getFontFamily, getMonoFontFamily } from '@/fonts'
import { useAccountId } from '@/hooks/account-scope'
import { useSettings } from '@/hooks/chat/settings'
import {
  type SettingsOverride,
  getSettingsOverride,
} from '@/lib/settings-override'
import { uiSettingsStore } from '@/lib/ui-settings'
import {
  DEFAULT_SETTINGS,
  type ResolvedSettings,
} from '@cv/convex/model/defaults'
import { useEffect, useSyncExternalStore } from 'react'

export type ResolvedFonts = {
  uiFont: string
  monoFont: string
  chatFont: string
  chatFontSize: number
}

/** Settings fields covered by the device-local font override. */
export const FONT_OVERRIDE_KEYS = [
  'uiFont',
  'monoFont',
  'chatFont',
  'chatFontSize',
] as const

export function useSettingsOverride(): SettingsOverride {
  const userId = useAccountId()
  return useSyncExternalStore(uiSettingsStore(userId).subscribe, () =>
    getSettingsOverride(userId),
  )
}

/** Resolves effective font values from synced settings + local override. */
export function resolveFonts(
  settings: ResolvedSettings | undefined,
  override: SettingsOverride,
): ResolvedFonts {
  return {
    uiFont: override.uiFont ?? settings?.uiFont ?? DEFAULT_SETTINGS.uiFont,
    monoFont:
      override.monoFont ?? settings?.monoFont ?? DEFAULT_SETTINGS.monoFont,
    chatFont:
      override.chatFont ?? settings?.chatFont ?? DEFAULT_SETTINGS.chatFont,
    chatFontSize:
      override.chatFontSize ??
      settings?.chatFontSize ??
      DEFAULT_SETTINGS.chatFontSize,
  }
}

export function useResolvedFonts(): ResolvedFonts {
  return resolveFonts(useSettings(), useSettingsOverride())
}

export function useFont(font: string) {
  useEffect(() => {
    document.documentElement.style.setProperty(
      '--font-sans',
      getFontFamily(font),
    )
    return () => {
      document.documentElement.style.removeProperty('--font-sans')
    }
  }, [font])
}

export function useMonoFont(font: string) {
  useEffect(() => {
    document.documentElement.style.setProperty(
      '--font-mono',
      getMonoFontFamily(font),
    )
    return () => {
      document.documentElement.style.removeProperty('--font-mono')
    }
  }, [font])
}
