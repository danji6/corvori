import { ContextMenu } from '@/components/ui/context-menu'
import { useOpenScriptManager } from '@/hooks/chat/script-manager'
import { useScripts } from '@/hooks/chat/scripts'
import { Selection } from '@tiptap/pm/state'
import type { Editor } from '@tiptap/react'
import {
  ClipboardPasteIcon,
  CopyIcon,
  ListChecksIcon,
  PlayIcon,
  ScissorsIcon,
  ScrollTextIcon,
} from 'lucide-react'
import { useState } from 'react'

import { applyScript } from '../apply-script'
import { copyEditorSelection, pasteIntoEditor } from './editor-clipboard'
import { ScriptIcon } from './script-toolbar'

type EditorContextMenuProps = {
  editor: Editor | null
  children: React.ReactNode
  onCancel?: () => void
}

export function EditorContextMenu({
  editor,
  children,
  onCancel,
}: EditorContextMenuProps) {
  const [open, setOpen] = useState(false)

  return (
    <ContextMenu
      disabled={!editor}
      onOpenChange={setOpen}
      onOpen={({ x, y }) => {
        if (!editor?.state.selection.empty) return
        const pos = editor.view.posAtCoords({ left: x, top: y })?.pos
        if (pos === undefined) return
        editor.view.dispatch(
          editor.state.tr.setSelection(
            Selection.near(editor.state.doc.resolve(pos)),
          ),
        )
      }}
    >
      <ContextMenu.Trigger>
        <div
          data-slot="editor-container"
          onKeyDown={(event) => {
            if (event.key !== 'Escape' || open || !onCancel) return
            event.preventDefault()
            onCancel()
          }}
        >
          {children}
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Content className="z-55">
        {editor && <EditorMenuItems editor={editor} />}
      </ContextMenu.Content>
    </ContextMenu>
  )
}

function EditorMenuItems({ editor }: { editor: Editor }) {
  const noSelection = editor.state.selection.empty

  return (
    <>
      <ScriptMenuItems editor={editor} />
      <ContextMenu.Separator />
      <ContextMenu.Item
        disabled={noSelection}
        onSelect={() => void copyEditorSelection(editor, true)}
      >
        <ScissorsIcon />
        Cut
      </ContextMenu.Item>
      <ContextMenu.Item
        disabled={noSelection}
        onSelect={() => void copyEditorSelection(editor, false)}
      >
        <CopyIcon />
        Copy
      </ContextMenu.Item>
      <ContextMenu.Item onSelect={() => void pasteIntoEditor(editor)}>
        <ClipboardPasteIcon />
        Paste
      </ContextMenu.Item>
      <ContextMenu.Item
        onSelect={() => {
          editor.view.focus()
          editor.commands.selectAll()
        }}
      >
        <ListChecksIcon />
        Select all
      </ContextMenu.Item>
    </>
  )
}

function ScriptMenuItems({ editor }: { editor: Editor }) {
  const openScriptManager = useOpenScriptManager()
  const { scripts, loaded } = useScripts()

  return (
    <>
      <ContextMenu.Item onSelect={openScriptManager}>
        <ScrollTextIcon />
        Scripts
      </ContextMenu.Item>
      <ContextMenu.Sub>
        <ContextMenu.SubTrigger>
          <PlayIcon />
          Run Script…
        </ContextMenu.SubTrigger>
        <ContextMenu.SubContent className="max-h-[calc(100dvh-1rem)] overflow-y-auto overscroll-contain">
          {!scripts.length && (
            <ContextMenu.Item disabled>
              {loaded ? 'No scripts' : 'Loading scripts…'}
            </ContextMenu.Item>
          )}
          {scripts.map((script) => (
            <ContextMenu.Item
              key={script.id}
              onSelect={() => applyScript(editor, script.code)}
            >
              <span aria-hidden="true">
                <ScriptIcon script={script} />
              </span>
              <span className="truncate">{script.name}</span>
            </ContextMenu.Item>
          ))}
        </ContextMenu.SubContent>
      </ContextMenu.Sub>
    </>
  )
}
