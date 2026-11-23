import { AccountScope } from '@/hooks/account-scope'
import { usePromptPreviews } from '@/hooks/chat/prompt-previews'
import { Suspense, lazy, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'

import { AttachmentDownloadFixture } from './attachment-download-fixture'
import { ChangesFixture } from './changes-fixture'
import { CheckboxFixture } from './checkbox-fixture'
import { CodeFixture } from './code-fixture'
import { McpCatalogFixture } from './mcp-catalog-fixture'
import { McpProtocolFixture } from './mcp-protocol-fixture'
import { McpSettingsFixture } from './mcp-settings-fixture'
import { ProviderConnectionsFixture } from './provider-connections-fixture'
import { ScrollFixture } from './scroll-fixture'
import { ToolSettingsFixture } from './tool-settings-fixture'
import { ToolkitsFixture } from './toolkits-fixture'

const AccountStorageFixture = lazy(() =>
  import('./account-storage-fixture').then((module) => ({
    default: module.AccountStorageFixture,
  })),
)

const XmlTagsFixture = lazy(() =>
  import('./xml-tags-fixture').then((module) => ({
    default: module.XmlTagsFixture,
  })),
)

const NotesFixture = lazy(() =>
  import('./notes-fixture').then((module) => ({
    default: module.NotesFixture,
  })),
)

const AppearanceFixture = lazy(() =>
  import('./appearance-fixture').then((module) => ({
    default: module.AppearanceFixture,
  })),
)

const MessagePaginationFixture = lazy(() =>
  import('./message-pagination-fixture').then((module) => ({
    default: module.MessagePaginationFixture,
  })),
)

const InlineSourceFixture = lazy(() =>
  import('./inline-source-fixture').then((module) => ({
    default: module.InlineSourceFixture,
  })),
)

const CodeCompletionFixture = lazy(() =>
  import('./code-completion-fixture').then((module) => ({
    default: module.CodeCompletionFixture,
  })),
)

const ScriptMenusFixture = lazy(() =>
  import('./script-menus-fixture').then((module) => ({
    default: module.ScriptMenusFixture,
  })),
)

const SkillSourceFixture = lazy(() =>
  import('./skill-source-fixture').then((module) => ({
    default: module.SkillSourceFixture,
  })),
)

const SkillsFixture = lazy(() =>
  import('./skills-fixture').then((module) => ({
    default: module.SkillsFixture,
  })),
)

const SkillToolsFixture = lazy(() =>
  import('./skill-tools-fixture').then((module) => ({
    default: module.SkillToolsFixture,
  })),
)

const SessionFoldersFixture = lazy(() =>
  import('./session-folders-fixture').then((module) => ({
    default: module.SessionFoldersFixture,
  })),
)

const EmptyChatFixture = lazy(() =>
  import('./empty-chat-fixture').then((module) => ({
    default: module.EmptyChatFixture,
  })),
)

const SubagentApprovalsFixture = lazy(() =>
  import('./subagent-approvals-fixture').then((module) => ({
    default: module.SubagentApprovalsFixture,
  })),
)

const NotificationsFixture = lazy(() =>
  import('./notifications-fixture').then((module) => ({
    default: module.NotificationsFixture,
  })),
)

const AccountSecurityFixture = lazy(() =>
  import('./account-security-fixture').then((module) => ({
    default: module.AccountSecurityFixture,
  })),
)

const UiLayoutFixture = lazy(() =>
  import('./ui-layout-fixture').then((module) => ({
    default: module.UiLayoutFixture,
  })),
)

const SidebarFixture = lazy(() =>
  import('./sidebar-fixture').then((module) => ({
    default: module.SidebarFixture,
  })),
)

function PreviewFixture() {
  const [source, setSource] = useState('{{ user }}')
  const [clicks, setClicks] = useState(0)
  const [modelId, setModelId] = useState('model-a')
  const texts = useMemo(() => [source], [source])
  const context = useMemo(
    () => ({
      user: 'Fixture user',
      modelId,
      modelName: modelId === 'model-a' ? 'Model A' : 'Model B',
    }),
    [modelId],
  )
  const [preview] = usePromptPreviews(texts, context)
  return (
    <main>
      <label>
        Prompt
        <textarea
          aria-label="Prompt"
          value={source}
          onChange={(event) => setSource(event.target.value)}
        />
      </label>
      <select
        aria-label="Model"
        value={modelId}
        onChange={(event) => setModelId(event.target.value)}
      >
        <option value="model-a">Model A</option>
        <option value="model-b">Model B</option>
      </select>
      <output aria-label="Preview">{preview}</output>
      <button onClick={() => setClicks((value) => value + 1)}>
        Respond {clicks}
      </button>
    </main>
  )
}

const fixtureName = new URLSearchParams(location.search).get('fixture')
const fixture =
  fixtureName === 'account-storage' ? (
    <Suspense fallback={null}>
      <AccountStorageFixture />
    </Suspense>
  ) : fixtureName === 'code' ? (
    <CodeFixture />
  ) : fixtureName === 'attachment-download' ? (
    <AttachmentDownloadFixture />
  ) : fixtureName === 'message-pagination' ? (
    <Suspense fallback={<p>Loading pagination…</p>}>
      <MessagePaginationFixture />
    </Suspense>
  ) : fixtureName === 'changes' ? (
    <ChangesFixture />
  ) : fixtureName === 'tool-settings' ? (
    <ToolSettingsFixture />
  ) : fixtureName === 'toolkits' ? (
    <ToolkitsFixture />
  ) : fixtureName === 'mcp-protocol' ? (
    <McpProtocolFixture />
  ) : fixtureName === 'mcp-settings' ? (
    <McpSettingsFixture />
  ) : fixtureName === 'mcp-catalog' ? (
    <McpCatalogFixture />
  ) : fixtureName === 'xml-tags' ? (
    <Suspense fallback={<p>Loading XML editors…</p>}>
      <XmlTagsFixture />
    </Suspense>
  ) : fixtureName === 'notifications' ? (
    <Suspense fallback={<p>Loading notifications…</p>}>
      <NotificationsFixture />
    </Suspense>
  ) : fixtureName === 'sidebar' ? (
    <Suspense fallback={<p>Loading sidebar…</p>}>
      <SidebarFixture />
    </Suspense>
  ) : fixtureName === 'ui-layout' ? (
    <Suspense fallback={<p>Loading layout…</p>}>
      <UiLayoutFixture />
    </Suspense>
  ) : fixtureName === 'subagent-approvals' ? (
    <Suspense fallback={<p>Loading approvals…</p>}>
      <SubagentApprovalsFixture />
    </Suspense>
  ) : fixtureName === 'provider-connections' ? (
    <ProviderConnectionsFixture />
  ) : fixtureName === 'script-menus' ? (
    <Suspense fallback={<p>Loading menus…</p>}>
      <ScriptMenusFixture />
    </Suspense>
  ) : fixtureName === 'code-completion' ? (
    <Suspense fallback={<p>Loading code editor…</p>}>
      <CodeCompletionFixture />
    </Suspense>
  ) : fixtureName === 'inline-source' ? (
    <Suspense fallback={<p>Loading editor…</p>}>
      <InlineSourceFixture />
    </Suspense>
  ) : fixtureName === 'account-security' ? (
    <Suspense fallback={<p>Loading account settings…</p>}>
      <AccountSecurityFixture />
    </Suspense>
  ) : fixtureName === 'empty-chat' ? (
    <Suspense fallback={null}>
      <EmptyChatFixture />
    </Suspense>
  ) : fixtureName === 'session-folders' ? (
    <Suspense fallback={<p>Loading session folders…</p>}>
      <SessionFoldersFixture />
    </Suspense>
  ) : fixtureName === 'skill-tools' ? (
    <Suspense fallback={<p>Loading tool fixture…</p>}>
      <SkillToolsFixture />
    </Suspense>
  ) : fixtureName === 'skill-source' ? (
    <Suspense fallback={<p>Loading source picker…</p>}>
      <SkillSourceFixture />
    </Suspense>
  ) : fixtureName === 'skills' ? (
    <Suspense fallback={<p>Loading skills fixture…</p>}>
      <SkillsFixture />
    </Suspense>
  ) : fixtureName === 'appearance' ? (
    <Suspense fallback={<p>Loading appearance…</p>}>
      <AppearanceFixture />
    </Suspense>
  ) : fixtureName === 'notes' ? (
    <Suspense fallback={<p>Loading notes…</p>}>
      <NotesFixture />
    </Suspense>
  ) : fixtureName === 'checkbox' ? (
    <CheckboxFixture />
  ) : fixtureName === 'scroll' ? (
    <ScrollFixture />
  ) : (
    <PreviewFixture />
  )
const userId = fixtureName === 'session-folders' ? 'fixture-owner' : 'owner'
createRoot(document.getElementById('root')!).render(
  <AccountScope userId={userId}>{fixture}</AccountScope>,
)
