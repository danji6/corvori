import { normalizeBrowserUrl } from '@/lib/auth/site-url'
import type { SessionArchive } from '@/lib/chat'
import type { Id } from '@cv/convex/_generated/dataModel'
import {
  attachmentNameSuffix,
  namelessAttachment,
  suffixFilename,
} from '@cv/core/utils/attachment-names'
import type { FileUIPart } from 'ai'

type ExportResult = { type: 'png' | 'json'; data: string; name: string }

/** Describes a local file without opening or copying its contents. */
export function describeUpload(file: File, id: string): FileUIPart {
  const filename = file.name.trim()
    ? file.name
    : suffixFilename(namelessAttachment(file.type), attachmentNameSuffix())
  return {
    type: 'file',
    url: `attachment:${id}`,
    mediaType: file.type || 'application/octet-stream',
    filename,
  }
}

export function triggerAgentDownload(result: ExportResult) {
  const { type, data, name } = result
  const blob =
    type === 'png'
      ? new Blob([decodeBase64(data)], { type: 'image/png' })
      : new Blob([data], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = type === 'png' ? `${name}.png` : `${name}.json`
  document.body.append(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

export function triggerJsonDownload(name: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: 'application/json',
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${safeFileBaseName(name)}.json`
  document.body.append(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

export async function readSessionArchive(file: File): Promise<SessionArchive> {
  return JSON.parse(await file.text()) as SessionArchive
}

export function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = globalThis.atob(value)
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }

  return bytes
}

export async function uploadAgentFile(
  file: File,
  generateUploadUrl: () => Promise<string>,
): Promise<
  | { type: 'png'; storageId: Id<'_storage'> }
  | { type: 'json'; data: Record<string, unknown> }
> {
  if (file.type === 'image/png' || file.name.endsWith('.png')) {
    const uploadUrl = normalizeBrowserUrl(await generateUploadUrl())
    if (!uploadUrl) throw new Error('Upload URL not available')
    const response = await fetch(uploadUrl, {
      method: 'POST',
      body: file,
      headers: { 'Content-Type': 'image/png' },
    })
    const { storageId } = (await response.json()) as {
      storageId: Id<'_storage'>
    }
    return { type: 'png', storageId }
  }

  const data = JSON.parse(await file.text()) as Record<string, unknown>
  return { type: 'json', data }
}

function safeFileBaseName(value: string) {
  const withoutControls = Array.from(value.trim(), (char) =>
    char < ' ' ? '-' : char,
  ).join('')
  const name = withoutControls
    .trim()
    .replace(/[<>:"/\\|?*]/g, '-')
    .replace(/\s+/g, ' ')
    .slice(0, 80)
    .trim()

  return name || 'session'
}
