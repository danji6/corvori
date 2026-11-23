import type { ResolvedSettings } from '@cv/convex/model/defaults'
import { APP_ID } from '@cv/core/const'

import { createAccountLocalStorage } from './local-storage-store'

export type SidebarSide = 'left' | 'right'

export type SidebarState = {
  pinned?: boolean
  collapsed?: boolean
}

export type SettingsOverride = Partial<
  Pick<ResolvedSettings, 'uiFont' | 'monoFont' | 'chatFont' | 'chatFontSize'>
>

export type AgentEditorSelection = {
  agentId?: string
  newAgent?: boolean
  /** Retains a successful create when a later avatar upload needs retrying. */
  createdAgentId?: string
}

export type UiSettings = {
  sidebar?: Partial<Record<SidebarSide, SidebarState>>
  selectedSessionFolder?: string | null
  folderCollapse?: Record<string, boolean>
  fonts?: SettingsOverride
  recentDirectories?: string[]
  agentEditor?: AgentEditorSelection
}

export const uiSettingsStore = createAccountLocalStorage<UiSettings>(
  `${APP_ID}-ui-settings`,
)

export function getSelectedSessionFolder(userId: string): string | null {
  return uiSettingsStore(userId).get().selectedSessionFolder ?? null
}

export function setSelectedSessionFolder(
  userId: string,
  folderId: string | null,
) {
  uiSettingsStore(userId).set({ selectedSessionFolder: folderId })
}

export function getSidebarState(
  userId: string,
  side: SidebarSide,
): SidebarState {
  return uiSettingsStore(userId).get().sidebar?.[side] ?? {}
}

export function setSidebarState(
  userId: string,
  side: SidebarSide,
  patch: SidebarState,
) {
  uiSettingsStore(userId).update(({ sidebar }) => ({
    sidebar: { ...sidebar, [side]: { ...sidebar?.[side], ...patch } },
  }))
}
