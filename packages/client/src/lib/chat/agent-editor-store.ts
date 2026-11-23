import { uiSettingsStore } from '../ui-settings'

export function getEditingAgentId(userId: string): string | null {
  return uiSettingsStore(userId).get().agentEditor?.agentId ?? null
}

export function setEditingAgentId(userId: string, agentId: string | null) {
  uiSettingsStore(userId).set({
    agentEditor: agentId ? { agentId } : undefined,
  })
}

export function isNewAgent(userId: string): boolean {
  return uiSettingsStore(userId).get().agentEditor?.newAgent === true
}

export function startNewAgent(userId: string) {
  uiSettingsStore(userId).set({ agentEditor: { newAgent: true } })
}

export function getCreatedAgentId(userId: string): string | undefined {
  return uiSettingsStore(userId).get().agentEditor?.createdAgentId
}

export function setCreatedAgentId(userId: string, createdAgentId: string) {
  uiSettingsStore(userId).update(({ agentEditor }) => ({
    agentEditor: { ...agentEditor, createdAgentId },
  }))
}
