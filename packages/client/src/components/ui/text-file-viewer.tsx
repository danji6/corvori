import type { FileItem } from '@/hooks/file-previews'
import { languageFromPath } from '@/lib/chat/tool-output'
import { extractErrorMessage } from '@/lib/errors'
import { openTextPreviewHighlighter } from '@/lib/shiki/highlighter'
import { readAttachmentTextPreview } from '@/lib/text-file-preview'
import { formatByteLength } from '@cv/core/utils/size'
import { useEffect, useRef, useState } from 'react'

import { Dialog } from './dialog'
import { LoadingIndicator } from './loading-indicator'
import { RippleButton } from './ripple-button'
import { type PreviewLine, TextPreviewContent } from './text-preview-content'

type PreviewState = {
  chunks: string[]
  lines: PreviewLine[]
  shownBytes: number
  truncated: boolean
  loading: boolean
  error?: string
}

type PreviewRequest = {
  pages: ReturnType<typeof readAttachmentTextPreview>
  signal: AbortSignal
  pending: boolean
  tail?: string
  highlight?: ReturnType<typeof openTextPreviewHighlighter>
}

const initialPreview: PreviewState = {
  chunks: [],
  lines: [],
  shownBytes: 0,
  truncated: false,
  loading: true,
}

/** Opens a preview for a text attachment. */
export function TextFileViewer({
  item,
  children,
}: {
  item: FileItem
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const sourceUrl = item.originalUrl ?? item.url

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Dialog.Trigger
        aria-label={`Preview ${item.file.name}`}
        className="file-preview-focus size-full cursor-pointer rounded-lg text-left"
      >
        {children}
      </Dialog.Trigger>
      <Dialog.Content className="grid h-[min(90svh,56rem)] max-w-[min(96vw,80rem)] grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0">
        <Dialog.Header className="border-border border-b px-6 py-5 pr-16">
          <Dialog.Title className="truncate">{item.file.name}</Dialog.Title>
          <Dialog.Description className="text-muted-foreground">
            {fileDescription(item)}
          </Dialog.Description>
        </Dialog.Header>
        {open && (
          <TextPreviewSession
            key={item.originalFile ? item.id : sourceUrl}
            source={item.originalFile ?? sourceUrl}
            language={languageFromPath(item.file.name)}
          />
        )}
      </Dialog.Content>
    </Dialog>
  )
}

function TextPreviewSession({
  source,
  language,
}: {
  source: string | File
  language?: string
}) {
  const [attempt, setAttempt] = useState(0)
  const [preview, setPreview] = useState(initialPreview)
  const request = useRef<PreviewRequest | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    const { signal } = controller
    const current = {
      pages: readAttachmentTextPreview(source, signal),
      signal,
      pending: false,
      highlight: language
        ? openTextPreviewHighlighter(language, signal)
        : undefined,
    }
    request.current = current
    void loadPage(current, setPreview)
    return () => {
      request.current = null
      controller.abort()
      void current.pages.return().catch(() => {})
    }
  }, [attempt, source, language])

  function restart() {
    setPreview(initialPreview)
    setAttempt((value) => value + 1)
  }

  function loadMore() {
    const current = request.current
    if (!current || current.pending) return
    setPreview((previous) => ({ ...previous, loading: true }))
    void loadPage(current, setPreview)
  }

  if (preview.chunks.length === 0) {
    return <InitialPreviewStatus error={preview.error} onRetry={restart} />
  }

  return (
    <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)]">
      {preview.truncated && (
        <PreviewNotice
          preview={preview}
          onLoadMore={loadMore}
          onRetry={restart}
        />
      )}
      <TextPreviewContent
        lines={preview.lines}
        chunks={preview.chunks}
        loading={preview.loading}
        truncated={preview.truncated}
      />
    </div>
  )
}

async function loadPage(
  request: PreviewRequest,
  setPreview: React.Dispatch<React.SetStateAction<PreviewState>>,
) {
  request.pending = true
  try {
    const { done, value } = await request.pages.next()
    if (done || request.signal.aborted) return
    if (!value.truncated) void request.pages.return().catch(() => {})

    const replacingTail = request.tail !== undefined
    const complete = ((request.tail ?? '') + value.text).split(/\r?\n/)
    const tail = value.truncated ? complete.pop() : undefined
    const lines = await previewLines(request.highlight, complete, tail)
    if (request.signal.aborted) return

    request.tail = tail
    setPreview((previous) => ({
      chunks: [...previous.chunks, value.text],
      lines: [
        ...(replacingTail ? previous.lines.slice(0, -1) : previous.lines),
        ...lines,
      ],
      shownBytes: value.shownBytes,
      truncated: value.truncated,
      loading: false,
    }))
  } catch (error) {
    if (request.signal.aborted) return
    setPreview((previous) => ({
      ...previous,
      loading: false,
      error: extractErrorMessage(error),
    }))
  } finally {
    request.pending = false
  }
}

/** Bounds worker input for unusually long lines and keeps them readable. */
function highlightableLine(line: string): string {
  return line.length <= 4096 ? line : ''
}

async function previewLines(
  highlight: PreviewRequest['highlight'],
  complete: string[],
  tail?: string,
): Promise<PreviewLine[]> {
  const text = tail === undefined ? complete : [...complete, tail]
  const html = await highlight?.(
    complete.length ? complete.map(highlightableLine).join('\n') : null,
    tail === undefined ? null : highlightableLine(tail),
  ).catch(() => undefined)
  return text.map((line, index) => ({ text: line, html: html?.[index] }))
}

function InitialPreviewStatus({
  error,
  onRetry,
}: {
  error?: string
  onRetry: () => void
}) {
  if (error === undefined) {
    return (
      <div className="flex items-center justify-center">
        <LoadingIndicator />
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center justify-center gap-4 p-8 text-center">
      <div role="alert">
        <p className="font-medium">Couldn’t load the text preview</p>
        <p className="text-muted-foreground mt-1 text-sm">{error}</p>
      </div>
      <RippleButton variant="surface" onClick={onRetry}>
        Try again
      </RippleButton>
    </div>
  )
}

function PreviewNotice({
  preview,
  onLoadMore,
  onRetry,
}: {
  preview: PreviewState
  onLoadMore: () => void
  onRetry: () => void
}) {
  return (
    <div className="border-border flex items-center justify-between gap-3 border-b px-6 py-2">
      <div className="text-muted-foreground text-xs" role="status">
        {preview.error ? (
          <>Couldn’t load more text. {preview.error}</>
        ) : (
          <>
            This file is too large to preview all at once. Showing the first{' '}
            {formatByteLength(preview.shownBytes)}.
          </>
        )}
      </div>
      <RippleButton
        className="shrink-0"
        variant="surface"
        size="sm"
        disabled={preview.loading}
        onClick={preview.error ? onRetry : onLoadMore}
      >
        {previewActionLabel(preview)}
      </RippleButton>
    </div>
  )
}

function previewActionLabel({ error, loading }: PreviewState) {
  if (error) return 'Restart preview'
  if (loading) return 'Loading…'
  return 'Load more'
}

function fileDescription(item: FileItem): string {
  const bytes = item.byteLength ?? item.file.size
  const details = [
    bytes > 0 ? formatByteLength(bytes) : null,
    item.file.type || null,
  ]
  return details.filter(Boolean).join(' · ') || 'Text attachment'
}
