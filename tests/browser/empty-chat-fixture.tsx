import { Chat } from '@/components/chat/chat'
import { ChatSidebars } from '@/components/chat/chat-sidebars'
import { ChatComposer } from '@/components/chat/composer/chat-composer'
import { EmptyChat } from '@/components/chat/empty-chat'
import { NotificationProvider } from '@/components/chat/notifications/notification-provider'
import { ChatSearchProvider } from '@/components/chat/search'
import { JoinSessionButton } from '@/components/chat/sessions/join-session'
import { LightboxProvider } from '@/components/ui/lightbox'
import '@/globals.css'
import { AvatarUrlProvider } from '@/hooks/chat/avatars'
import { useActiveSessionId } from '@/hooks/chat/session'
import { StreamStoreProvider } from '@/hooks/chat/stream'
import { applyTheme, exportSchemeCss } from '@/lib/theme'
import { generateThemeCss } from '@/lib/theme-worker'
import { ConvexQueryCacheProvider } from 'convex-helpers/react/cache'
import { ConvexProviderWithAuth } from 'convex/react'
import { useState } from 'react'
import { Link } from 'wouter'

import { emptyChatClient, sentMessages } from './empty-chat-client'

const shellTheme = new URLSearchParams(location.search).has('shellTheme')
if (!shellTheme) {
  const sourceColor = '#70896b'
  const { css } = exportSchemeCss(sourceColor, true, 0)
  applyTheme({ sourceColor, mode: 'dark', contrast: 0, css })
}

function SessionThemeFixture() {
  const activeSessionId = useActiveSessionId()
  return (
    <>
      <output aria-label="Current session">{activeSessionId}</output>
      <Link href="?fixture=empty-chat&shellTheme&id=agent-1">
        Switch to themed agent
      </Link>
      <Link href="?fixture=empty-chat&shellTheme&id=agent-2">
        Switch to unthemed agent
      </Link>
      <button
        onClick={async () => {
          // Drain pending theme work before resolving the selected agent.
          await generateThemeCss('#274cad', false)
          window.dispatchEvent(new Event('resolve-agent-details'))
        }}
      >
        Resolve agent details
      </button>
      <button
        onClick={async () => {
          await generateThemeCss('#ad2740', false)
          window.dispatchEvent(new Event('resolve-session-messages'))
        }}
      >
        Resolve session messages
      </button>
      <LightboxProvider>
        <NotificationProvider>
          <Chat />
        </NotificationProvider>
      </LightboxProvider>
    </>
  )
}

function CreateSessionFixture() {
  const sessionId = useActiveSessionId()
  const [firstMessage, setFirstMessage] = useState('')
  if (!sessionId) {
    return (
      <EmptyChat
        onFirstMessage={(message) => setFirstMessage(message.content)}
      />
    )
  }
  return (
    <div className="w-full">
      <output aria-label="Opening message">{firstMessage || 'None'}</output>
      <output aria-label="Session create calls">
        {JSON.stringify(sentMessages)}
      </output>
      <ChatComposer
        status="ready"
        hideTokenWidget
        draftKey={sessionId}
        onSubmit={() => {}}
      />
    </div>
  )
}

export function EmptyChatFixture() {
  const params = new URLSearchParams(location.search)
  const chat = (
    <LightboxProvider>
      <EmptyChat onFirstMessage={() => {}} />
    </LightboxProvider>
  )
  return (
    <ConvexProviderWithAuth client={emptyChatClient} useAuth={useFixtureAuth}>
      <ConvexQueryCacheProvider>
        <StreamStoreProvider>
          <main className="bg-background text-foreground flex min-h-dvh w-full">
            {shellTheme ? (
              <SessionThemeFixture />
            ) : params.has('createSession') ? (
              <LightboxProvider>
                <CreateSessionFixture />
              </LightboxProvider>
            ) : params.has('joinSession') ? (
              <>
                <AvatarUrlProvider />
                <JoinSessionButton />
              </>
            ) : params.has('withNavigation') ? (
              <ChatSearchProvider>
                <NotificationProvider>
                  <ChatSidebars className="min-w-0 flex-1">{chat}</ChatSidebars>
                </NotificationProvider>
              </ChatSearchProvider>
            ) : (
              chat
            )}
          </main>
        </StreamStoreProvider>
      </ConvexQueryCacheProvider>
    </ConvexProviderWithAuth>
  )
}

const useFixtureAuth = () => ({
  isLoading: false,
  isAuthenticated: true,
  fetchAccessToken: async () => 'fixture-token',
})
