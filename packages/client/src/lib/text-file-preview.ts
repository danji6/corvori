import { readUtf8Range } from '@cv/core/attachments'

export const MAX_TEXT_PREVIEW_BYTES = 1024 * 1024
const ATTACHMENT_PREVIEW_PAGE_BYTES = 64 * 1024

export type TextPreview = {
  text: string
  shownBytes: number
  truncated: boolean
}

/** Reads one page at a time from the same attachment response. */
export async function* readAttachmentTextPreview(
  source: string | File,
  signal: AbortSignal,
): AsyncGenerator<TextPreview, void> {
  const stream =
    typeof source === 'string'
      ? (await fetchAttachment(source, signal)).body
      : source.stream()
  if (!stream) {
    yield { text: '', shownBytes: 0, truncated: false }
    return
  }

  const reader = stream.getReader()
  try {
    yield* readPreviewPages(reader, signal)
  } finally {
    await reader.cancel().catch(() => {})
  }
}

async function* readPreviewPages(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
) {
  const decoder = new TextDecoder()
  let text = ''
  let shownBytes = 0
  let remaining = ATTACHMENT_PREVIEW_PAGE_BYTES

  while (true) {
    signal.throwIfAborted()
    const next = await reader.read()
    if (next.done) {
      yield { text: text + decoder.decode(), shownBytes, truncated: false }
      return
    }

    const chunk = next.value
    for (let offset = 0; offset < chunk.byteLength;) {
      if (remaining === 0) {
        yield { text, shownBytes, truncated: true }
        signal.throwIfAborted()
        text = ''
        remaining = ATTACHMENT_PREVIEW_PAGE_BYTES
      }

      const length = Math.min(remaining, chunk.byteLength - offset)
      text += decoder.decode(chunk.subarray(offset, offset + length), {
        stream: true,
      })
      offset += length
      remaining -= length
      shownBytes += length
    }
  }
}

/** Reads at most one browser-safe preview window from a URL. */
export async function readTextPreview(
  url: string,
  signal: AbortSignal,
  maxBytes = MAX_TEXT_PREVIEW_BYTES,
  { fatal = true }: { fatal?: boolean } = {},
): Promise<TextPreview> {
  const response = await fetchAttachment(url, signal)
  const reader = response.body?.getReader()
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    return decodePreview(bytes, maxBytes, bytes.length > maxBytes, fatal)
  }

  const readLimit = maxBytes + 4
  const chunks: Uint8Array[] = []
  let byteLength = 0
  let done = false

  try {
    while (byteLength < readLimit) {
      const next = await reader.read()
      done = next.done
      if (done) break
      if (!next.value) continue

      const remaining = readLimit - byteLength
      const chunk = next.value.subarray(0, remaining)
      chunks.push(chunk)
      byteLength += chunk.byteLength
      if (chunk.byteLength < next.value.byteLength) break
    }
  } finally {
    if (!done) await reader.cancel().catch(() => {})
  }

  return decodePreview(
    joinBytes(chunks, byteLength),
    maxBytes,
    !done || byteLength > maxBytes,
    fatal,
  )
}

async function fetchAttachment(url: string, signal: AbortSignal) {
  const response = await fetch(url, { signal })
  if (!response.ok)
    throw new Error(`Failed to load attachment (${response.status})`)
  return response
}

function decodePreview(
  bytes: Uint8Array,
  maxBytes: number,
  truncated: boolean,
  fatal: boolean,
): TextPreview {
  const range = readUtf8Range(bytes, 0, maxBytes, { fatal })
  return {
    text: range.content,
    shownBytes: range.endOffset,
    truncated: truncated || range.truncated,
  }
}

function joinBytes(chunks: Uint8Array[], byteLength: number): Uint8Array {
  const bytes = new Uint8Array(byteLength)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}
