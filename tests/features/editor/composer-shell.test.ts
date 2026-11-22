/// <reference types="bun-types" />
import {
  pasteComposerShellText,
  serializeComposerContent,
  setComposerContent,
} from '@/lib/chat/composer-content'
import { editorKit } from '@/lib/tiptap/kit'
import { parseShellCommand } from '@cv/core/shell/command'
import { Editor } from '@tiptap/core'
import { afterEach, expect, test } from 'bun:test'
import { setupDom } from '~/tests/setup/dom'

setupDom()
let editor: Editor | undefined
afterEach(() => editor?.destroy())

function open(content = '') {
  editor = new Editor({
    extensions: editorKit({ collapseBlocks: true }),
    content,
    contentType: 'markdown',
  })
  editor.commands.setTextSelection(editor.state.doc.content.size - 1)
  return editor
}

test('pasting a full shell invocation preserves Markdown-like syntax and line breaks', () => {
  const composer = open()
  const source =
    "$ cat <<'EOF'\r\n\r\n> [name](https://example.com)\r\n  *  \r\nEOF"
  const expected = source.replaceAll('\r\n', '\n')

  expect(pasteComposerShellText(composer, source)).toBe(true)
  expect(serializeComposerContent(composer)).toBe(expected)

  setComposerContent(composer, serializeComposerContent(composer))
  expect(serializeComposerContent(composer)).toBe(expected)
  expect(composer.view.dom.querySelector('a')).toBeNull()
})

test('a URL already linked before the shell prefix was entered is sent literally', () => {
  const composer = open('[example.com](http://example.com)')
  expect(composer.view.dom.querySelector('a')).not.toBeNull()
  expect(serializeComposerContent(composer)).toBe(
    '[example.com](http://example.com)',
  )

  composer.view.dispatch(composer.state.tr.insertText('$ echo ', 1))
  expect(parseShellCommand(serializeComposerContent(composer))).toBe(
    'echo example.com',
  )
})

test('shell-like text pasted within a chat message uses ordinary paste handling', () => {
  const composer = open('Example: ')
  expect(pasteComposerShellText(composer, '$ echo example.com')).toBe(false)
  expect(serializeComposerContent(composer)).toBe('Example:')
})
