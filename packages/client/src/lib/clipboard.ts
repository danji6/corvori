type ClipboardContent = { text: string; html?: string }

/** Write text using the Clipboard API or a synchronous copy on plain HTTP. */
export async function writeClipboardText(text: string, html?: string) {
  const clipboard = navigator.clipboard
  try {
    if (html && clipboard?.write && typeof ClipboardItem !== 'undefined') {
      await clipboard.write([
        new ClipboardItem({
          'text/plain': new Blob([text], { type: 'text/plain' }),
          'text/html': new Blob([html], { type: 'text/html' }),
        }),
      ])
      return
    }
    if (clipboard?.writeText) {
      await clipboard.writeText(text)
      return
    }
  } catch {
    // The browser may still allow copying during the user's gesture.
  }
  if (!copyWithCommand({ text, html })) {
    throw new Error('Could not copy to the clipboard')
  }
}

/** Try a native paste into the focused editor if clipboard reads are unavailable. */
export async function pasteFromClipboard(
  insert: (content: ClipboardContent) => void,
) {
  const clipboard = navigator.clipboard
  if (!clipboard?.read && !clipboard?.readText) {
    try {
      return document.execCommand('paste')
    } catch {
      return false
    }
  }

  let content: ClipboardContent
  try {
    content = await readClipboard(clipboard)
  } catch {
    return false
  }
  if (content.text || content.html) insert(content)
  return true
}

async function readClipboard(clipboard: Clipboard): Promise<ClipboardContent> {
  if (!clipboard.read) return { text: await clipboard.readText() }

  const items = await clipboard.read()
  const item = items.find(({ types }) =>
    types.some((type) => type === 'text/plain' || type === 'text/html'),
  )
  if (!item) return { text: '' }

  const [text, html] = await Promise.all([
    readItem(item, 'text/plain'),
    readItem(item, 'text/html'),
  ])
  return { text: text ?? '', html }
}

async function readItem(item: ClipboardItem, type: string) {
  if (!item.types.includes(type)) return undefined
  return (await item.getType(type)).text()
}

function copyWithCommand({ text, html }: ClipboardContent): boolean {
  const field = document.createElement('textarea')
  field.value = text
  field.readOnly = true
  field.style.cssText =
    'position:fixed;top:0;left:0;opacity:0;pointer-events:none'
  const active = document.activeElement
  const selection = document.getSelection()
  const anchor = selection?.anchorNode
  const focus = selection?.focusNode
  const anchorOffset = selection?.anchorOffset ?? 0
  const focusOffset = selection?.focusOffset ?? 0
  const container = active?.closest('[role="dialog"]') ?? document.body

  field.addEventListener('copy', (event) => {
    if (!event.clipboardData) return
    event.clipboardData.setData('text/plain', text)
    if (html) event.clipboardData.setData('text/html', html)
    event.preventDefault()
    event.stopPropagation()
  })
  container.append(field)
  try {
    field.focus({ preventScroll: true })
    field.select()
    return document.execCommand('copy')
  } finally {
    field.remove()
    if (active instanceof HTMLElement) active.focus({ preventScroll: true })
    if (anchor?.isConnected && focus?.isConnected) {
      selection?.setBaseAndExtent(anchor, anchorOffset, focus, focusOffset)
    }
  }
}
