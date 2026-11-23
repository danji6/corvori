import { useAccountId } from '@/hooks/account-scope'
import { type ViewHandle, useView } from '@/hooks/view'
import {
  getEditingAgentId,
  isNewAgent,
  setEditingAgentId,
} from '@/lib/chat/agent-editor-store'
import { useCallback } from 'react'

import { useActiveAgent, useOwnedAgents } from './agent'

/** `?view=` segment owned by the agent editor; its value is the active tab. */
export const AGENT_EDITOR_VIEW = 'agent'

export const AGENT_EDITOR_DEFAULT_TAB = 'profile'

export function useAgentEditorView(): ViewHandle {
  return useView(AGENT_EDITOR_VIEW)
}

export function useAgentEditorOpen(): boolean {
  return useAgentEditorView().active
}

export function useOpenAgentEditor(fromView = AGENT_EDITOR_VIEW): () => void {
  const userId = useAccountId()
  const view = useView(fromView)
  const owned = useOwnedAgents()
  const activeAgent = useActiveAgent()

  return useCallback(() => {
    const current = getEditingAgentId(userId)
    const editable = owned?.some((agent) => agent._id === current)
    const fallback = owned?.find((agent) => agent._id === activeAgent?._id)
    if (!isNewAgent(userId) && !editable && fallback)
      setEditingAgentId(userId, fallback._id)

    view.switchTo(AGENT_EDITOR_VIEW, AGENT_EDITOR_DEFAULT_TAB)
  }, [view, owned, activeAgent, userId])
}
