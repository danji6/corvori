import { CodeAppearanceContext } from '@/components/markdown/code-appearance'
import { DialogErrorBoundary } from '@/components/ui'
import { useResolvedSettings } from '@/hooks/chat/resolved-settings'
import { useChatShellState } from '@/hooks/chat/shell-state'
import type { PendingMessage } from '@/lib/chat'
import { cn } from '@/lib/utils'
import { Suspense, lazy, useMemo, useState } from 'react'
import { useLocation } from 'wouter'

import { ChatSession } from './chat-session'
import { ChatSidebars } from './chat-sidebars'
import type { ChatProps } from './chat-types'
import { DraftRestoreDialog } from './draft-restore-dialog'
import { EmptyChat } from './empty-chat'
import { AgentSettings } from './entities/agent/agent-settings'
import { UserSettings } from './entities/user/user-settings'
import { ScriptManager } from './messages/editor/menu/script-manager'
import { ChatSearchProvider } from './search'

const TasksPage = lazy(() => import('./tasks/tasks-page'))

export type { ChatProps } from './chat-types'

type FirstMessage = { sessionId: string; message: PendingMessage }

export function Chat(props: ChatProps) {
  const [path] = useLocation()
  const tasksOpen = path === '/tasks' || path.startsWith('/tasks/')
  const [firstMessage, setFirstMessage] = useState<FirstMessage | null>(null)

  const {
    activeSessionId,
    activeAgentName,
    activeAgentDisplay,
    markSessionSettled,
    style,
  } = useChatShellState(props.layoutConstraint)

  const { codeBlockHighlighting, codeBlockLineNumbers } = useResolvedSettings()

  const codeAppearance = useMemo(
    () => ({
      highlighting: codeBlockHighlighting,
      lineNumbers: codeBlockLineNumbers,
    }),
    [codeBlockHighlighting, codeBlockLineNumbers],
  )

  return (
    <CodeAppearanceContext.Provider value={codeAppearance}>
      <ChatSearchProvider>
        <ChatSidebars
          data-slot="chat-area"
          className={cn('relative flex min-h-dvh flex-row', props.className)}
          style={style}
        >
          {tasksOpen ? (
            <Suspense fallback={<p>Loading tasks…</p>}>
              <TasksPage />
            </Suspense>
          ) : activeSessionId ? (
            <ChatSession
              sessionId={activeSessionId}
              pendingMessage={
                firstMessage?.sessionId === activeSessionId
                  ? firstMessage.message
                  : null
              }
              onPendingStarted={() =>
                setFirstMessage((current) =>
                  current === firstMessage ? null : current,
                )
              }
              activeAgentName={activeAgentName}
              activeAgentDisplay={activeAgentDisplay}
              onInitialPositionSettled={markSessionSettled}
              width={props.width}
              onError={props.onError}
            />
          ) : (
            <EmptyChat
              onFirstMessage={(message, sessionId) =>
                setFirstMessage({ sessionId, message })
              }
              activeAgentName={activeAgentName}
              activeAgentDisplay={activeAgentDisplay}
              {...props}
            />
          )}
          <AgentSettings />
          <UserSettings />
          <DialogErrorBoundary>
            <ScriptManager />
          </DialogErrorBoundary>
          <DialogErrorBoundary>
            <DraftRestoreDialog />
          </DialogErrorBoundary>
        </ChatSidebars>
      </ChatSearchProvider>
    </CodeAppearanceContext.Provider>
  )
}
