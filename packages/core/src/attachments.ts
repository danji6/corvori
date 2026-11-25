import { LARGE_PASTE_BYTES } from './const'

const ATTACHMENT_SCHEME = 'attachment:'

export type AttachmentReference = { attachmentId: string; filename: string }

/** Identifies a stored file occurrence, including older files without an ID. */
export function messageFileKey(part: unknown): string | undefined {
  if (typeof part !== 'object' || part === null) return
  const { type, url, attachmentId, mediaType, filename } = part as Record<
    string,
    unknown
  >
  if (type !== 'file' || typeof url !== 'string') return
  return typeof attachmentId === 'string' && attachmentId
    ? JSON.stringify([attachmentId])
    : JSON.stringify([url, mediaType, filename])
}

/** Whether a part should survive removal of the message's last attachment. */
export function isAttachmentCompanionContent(part: unknown): boolean {
  if (typeof part !== 'object' || part === null) return true
  const { type, text } = part as Record<string, unknown>
  if (type === 'step-start') return false
  if (type === 'text' || type === 'reasoning') {
    return typeof text === 'string' && Boolean(text.trim())
  }
  return true
}

/** Whether a composer paste should be represented as an attachment. */
export function shouldAttachTextPaste(
  text: string,
  commandMode = false,
): boolean {
  if (commandMode || /^\s*(?:\/|\$\s)/.test(text)) return false
  return new TextEncoder().encode(text).byteLength >= LARGE_PASTE_BYTES
}

/** Builds a host-independent reference to an attachment in a session. */
export function attachmentRef(attachmentId: string, filename: string): string {
  const encoded = encodeURIComponent(filename)
    .replaceAll('(', '%28')
    .replaceAll(')', '%29')
  return `${ATTACHMENT_SCHEME}${attachmentId}/${encoded}`
}

/** Parses a reference emitted in agent context. */
export function attachmentReference(value: string): AttachmentReference | null {
  if (!value.startsWith(ATTACHMENT_SCHEME)) return null
  const match = /^([a-z0-9]+)\/([^/?#]+)$/.exec(
    value.slice(ATTACHMENT_SCHEME.length),
  )
  if (!match) return null
  try {
    return { attachmentId: match[1], filename: decodeURIComponent(match[2]) }
  } catch {
    return null
  }
}

/** Adds a file record hint to a public storage URL. */
export function attachmentShareUrl(value: string, fileId: string): string {
  const url = new URL(value)
  url.hash = `attachment=${fileId}`
  return url.href
}

/** Reads the record hint without treating it as authorization. */
export function attachmentShare(value: string) {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    const match = /^#attachment=([a-z0-9]+)$/.exec(url.hash)
    if (!match) return null

    url.hash = ''
    return { fileId: match[1], url: url.href }
  } catch {
    return null
  }
}

export type Utf8Range = {
  content: string
  offset: number
  endOffset: number
  nextOffset: number | null
  totalBytes: number
  eof: boolean
  truncated: boolean
}

/** Decodes a byte-bounded UTF-8 window without splitting a code point. */
export function readUtf8Range(
  bytes: Uint8Array,
  requestedOffset: number,
  requestedLimit: number,
  { fatal = true }: { fatal?: boolean } = {},
): Utf8Range {
  let offset = Math.min(Math.max(0, Math.floor(requestedOffset)), bytes.length)
  const limit = Math.max(1, Math.floor(requestedLimit))
  if (fatal || offset > 0) {
    while (offset < bytes.length && isUtf8ContinuationByte(bytes[offset]!))
      offset += 1
  }

  let endOffset = Math.min(bytes.length, offset + limit)
  while (endOffset > offset && isUtf8ContinuationByte(bytes[endOffset]!)) {
    endOffset -= 1
  }
  if (endOffset === offset && offset < bytes.length) {
    endOffset += 1
    while (
      endOffset < bytes.length &&
      isUtf8ContinuationByte(bytes[endOffset]!)
    ) {
      endOffset += 1
    }
  }

  const eof = endOffset >= bytes.length
  return {
    content: decodeUtf8Range(bytes, offset, endOffset, fatal),
    offset,
    endOffset,
    nextOffset: eof ? null : endOffset,
    totalBytes: bytes.length,
    eof,
    truncated: !eof,
  }
}

/** Decodes a range with aligned boundaries, preserving any embedded BOM. */
export function decodeUtf8Range(
  bytes: Uint8Array,
  offset: number,
  endOffset: number,
  fatal = true,
): string {
  return new TextDecoder('utf-8', {
    fatal,
    ignoreBOM: offset > 0,
  }).decode(bytes.subarray(offset, endOffset))
}

export function isUtf8ContinuationByte(byte: number): boolean {
  return (byte & 0xc0) === 0x80
}
