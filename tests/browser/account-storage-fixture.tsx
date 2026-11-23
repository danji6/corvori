import { AccountScope, useAccountId } from '@/hooks/account-scope'
import { useComposerAttachments } from '@/hooks/chat/composer-attachments'
import { useComposerDraft } from '@/lib/chat/composer-draft-store'
import {
  getSavedScroll,
  setSavedScroll,
} from '@/lib/chat/scroll-position-store'
import type { SharedAttachment } from '@/lib/chat/types'
import { setSidebarState, uiSettingsStore } from '@/lib/ui-settings'
import type { Editor } from '@tiptap/react'
import { useRef, useState, useSyncExternalStore } from 'react'

const SESSION_ID = 'shared-chat'
const attachment: SharedAttachment = {
  fileId: 'draft-file' as SharedAttachment['fileId'],
  filename: 'Draft.png',
  mediaType: 'image/png',
  byteLength: 20,
  previewUrl: null,
  shareUrl: 'https://example.test/file#attachment=draft-file',
  url: 'https://example.test/file',
}

export function AccountStorageFixture() {
  const [userId, setUserId] = useState('alice')
  return (
    <AccountScope userId={userId}>
      <AccountStoragePanel
        switchAccount={() => setUserId(userId === 'alice' ? 'bob' : 'alice')}
      />
    </AccountScope>
  )
}

function AccountStoragePanel({ switchAccount }: { switchAccount: () => void }) {
  const userId = useAccountId()
  const draft = useComposerDraft(SESSION_ID)
  const editorRef = useRef<Editor>(null)
  const attachments = useComposerAttachments({
    draftKey: SESSION_ID,
    editorRef,
  })
  const settings = uiSettingsStore(userId)
  const pinned = useSyncExternalStore(
    settings.subscribe,
    () => settings.get().sidebar?.left?.pinned ?? false,
  )
  const [offset, setOffset] = useState(
    () => getSavedScroll(userId, SESSION_ID)?.offset ?? 0,
  )

  function saveScroll() {
    setSavedScroll(userId, SESSION_ID, {
      anchorId: 'shared-message',
      creationTime: 1,
      offset: 48,
      following: false,
    })
    setOffset(48)
  }

  return (
    <main>
      <output aria-label="Account">{userId}</output>
      <button onClick={switchAccount}>Switch account</button>
      <button
        onClick={() => {
          draft.save('Pending before switch')
          switchAccount()
        }}
      >
        Schedule draft and switch
      </button>
      <button
        aria-pressed={pinned}
        onClick={() => setSidebarState(userId, 'left', { pinned: !pinned })}
      >
        Pin sidebar
      </button>
      <textarea
        aria-label="Composer draft"
        defaultValue={draft.read()}
        onChange={(event) => draft.save(event.currentTarget.value)}
      />
      <button
        disabled={!attachments.isRestored}
        onClick={() => attachments.addSharedFiles([attachment])}
      >
        Attach draft file
      </button>
      <output aria-label="Draft attachments">
        {attachments.fileParts.map((part) => part.filename).join(', ')}
      </output>
      <button onClick={saveScroll}>Save scroll position</button>
      <output aria-label="Scroll offset">{offset}</output>
    </main>
  )
}
