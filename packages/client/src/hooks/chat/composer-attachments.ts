import { useAccountId } from '@/hooks/account-scope'
import type { FileItem } from '@/hooks/file-previews'
import { normalizeBrowserUrl } from '@/lib/auth/site-url'
import {
  type ComposerAttachmentDraft,
  clearComposerAttachmentDraft,
  readComposerAttachmentDraft,
  sharedFilePart,
  writeComposerAttachmentDraft,
} from '@/lib/chat/composer-attachment-draft-store'
import { processFileForUpload } from '@/lib/chat/io'
import { buildFileItemFromPart } from '@/lib/chat/parts'
import type {
  PendingFilePart,
  PendingMessage,
  SharedAttachment,
} from '@/lib/chat/types'
import { toastError } from '@/lib/notifications'
import { generateId } from '@/lib/utils'
import {
  attachmentNameSuffix,
  suffixFilename,
} from '@cv/core/utils/attachment-names'
import type { Editor } from '@tiptap/react'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { RefObject } from 'react'

type PastedText = NonNullable<PendingMessage['pastedText']>

export type ComposerFileBatch = File[] | Promise<File[]>

type AttachmentQueue = {
  signal: AbortSignal
  tail: Promise<unknown>
  pending: number
}

type UseComposerAttachmentsOptions = {
  draftKey?: string
  editorRef: RefObject<Editor | null>
}

/** Owns composer attachments, large-text pastes, and attachment draft effects. */
export function useComposerAttachments({
  draftKey: resourceKey,
  editorRef,
}: UseComposerAttachmentsOptions) {
  const userId = useAccountId()
  const draftKey = resourceKey ? JSON.stringify([userId, resourceKey]) : undefined // prettier-ignore
  const [fileParts, setFileParts] = useState<PendingFilePart[]>([])
  const [originalFiles, setOriginalFiles] = useState<Record<string, File>>({})
  const [pastedText, setPastedText] = useState<PastedText>({})
  const [restoredDraftKey, setRestoredDraftKey] = useState<string | null>(null)
  const revision = useRef(0)
  const filePartsRef = useRef(fileParts)
  const attachmentQueue = useRef<AttachmentQueue | null>(null)
  const retainedFiles = useRef<Set<string>>(new Set())
  const saveTimeout = useRef<number | undefined>(undefined)
  const [processingKey, setProcessingKey] = useState<string | null>()

  useLayoutEffect(() => {
    const controller = new AbortController()
    attachmentQueue.current = {
      signal: controller.signal,
      tail: Promise.resolve(),
      pending: 0,
    }
    retainedFiles.current.clear()
    return () => controller.abort()
  }, [draftKey])

  useEffect(() => {
    filePartsRef.current = fileParts
  }, [fileParts])

  useEffect(() => {
    if (!draftKey) return
    let cancelled = false

    void restoreAttachmentDraft(draftKey).then((restored) => {
      if (cancelled) return
      if (filePartsRef.current.length === 0 && restored) {
        revision.current++
        setFileParts(restored.fileParts)
        setOriginalFiles(restored.originalFiles)
        setPastedText(restored.pastedText)
        retainedFiles.current = new Set(Object.keys(restored.originalFiles))
      }
      setRestoredDraftKey(draftKey)
    })

    return () => {
      cancelled = true
    }
  }, [draftKey])

  useEffect(() => {
    if (!draftKey || restoredDraftKey !== draftKey) return
    saveTimeout.current = window.setTimeout(() => {
      const attachments = attachmentDraft(
        fileParts,
        originalFiles,
        pastedText,
        retainedFiles.current,
      )
      void writeComposerAttachmentDraft(draftKey, attachments)
    }, 300)
    return () => window.clearTimeout(saveTimeout.current)
  }, [draftKey, fileParts, originalFiles, pastedText, restoredDraftKey])

  function prepareAttachmentMove() {
    if (draftKey && restoredDraftKey !== draftKey) return null
    if (attachmentQueue.current?.pending) return null
    const attachments = attachmentDraft(fileParts, originalFiles, pastedText)
    return async (destination: string) => {
      if (attachments.length) {
        await writeComposerAttachmentDraft(
          JSON.stringify([userId, destination]),
          attachments,
          { retainOnFailure: true },
        )
      }
      window.clearTimeout(saveTimeout.current)
      if (draftKey) await clearComposerAttachmentDraft(draftKey)
    }
  }

  const files = useMemo<FileItem[]>(
    () =>
      fileParts.map((part) => buildDraftFileItem(part, part.id in pastedText)),
    [fileParts, pastedText],
  )

  const restoreAttachments = useCallback((message: PendingMessage) => {
    revision.current++
    filePartsRef.current = message.files
    setFileParts(message.files)
    setOriginalFiles(message.originalFiles ?? {})
    setPastedText(message.pastedText ?? {})
  }, [])

  const resetAttachments = useCallback(() => {
    revision.current++
    filePartsRef.current = []
    setFileParts([])
    setOriginalFiles({})
    setPastedText({})
  }, [])

  const clearAttachmentDraft = useCallback(() => {
    if (draftKey) void clearComposerAttachmentDraft(draftKey)
  }, [draftKey])

  // Keep later picks and pastes from overtaking files still being processed.
  const enqueueAttachment = useCallback(
    <T>(add: (signal: AbortSignal) => Promise<T>, canceled: T) => {
      const queue = attachmentQueue.current
      if (!queue) return Promise.resolve(canceled)
      const { signal } = queue
      queue.pending++
      setProcessingKey(draftKey ?? null)
      const result = queue.tail
        .then(() => (signal.aborted ? canceled : add(signal)))
        .finally(() => {
          queue.pending--
          if (attachmentQueue.current === queue && !queue.pending)
            setProcessingKey(undefined)
        })
      queue.tail = result.catch(() => undefined)
      return result
    },
    [draftKey],
  )

  const addFiles = useCallback(
    (picked: ComposerFileBatch) => {
      // Read the drop immediately, but commit it in the same queue as picks and pastes.
      const batch = Promise.resolve(picked).then(
        (files) => ({ files }),
        (error: unknown) => ({ error }),
      )
      return enqueueAttachment(async (signal) => {
        try {
          const result = await batch
          if (signal.aborted) return false
          if ('error' in result) throw result.error
          for (const file of result.files) {
            const { part, originalFile } = await processComposerFile(file)
            if (signal.aborted) return false
            revision.current++
            setFileParts((previous) => [...previous, part])
            if (originalFile) {
              setOriginalFiles((previous) => ({
                ...previous,
                [part.id]: originalFile,
              }))
            }
          }
          return result.files.length > 0
        } catch (error) {
          if (!signal.aborted) toastError(error, 'Failed to process file')
          return false
        }
      }, false)
    },
    [enqueueAttachment],
  )

  const addLargeTextPaste = useCallback(
    (text: string, position: number) => {
      const filename = suffixFilename('pasted-text.txt', attachmentNameSuffix())
      const file = new File([text], filename, {
        type: 'text/plain;charset=utf-8',
      })

      return enqueueAttachment(async (signal) => {
        try {
          const { part, originalFile } = await processComposerFile(file)
          if (signal.aborted) return
          revision.current++
          setFileParts((previous) => [...previous, part])
          setOriginalFiles((previous) => ({
            ...previous,
            [part.id]: originalFile ?? file,
          }))
          setPastedText((previous) => ({
            ...previous,
            [part.id]: { text, position },
          }))
        } catch (error) {
          if (!signal.aborted) toastError(error, 'Failed to attach pasted text')
        }
      }, undefined)
    },
    [enqueueAttachment],
  )

  const addSharedFiles = useCallback((shares: SharedAttachment[]) => {
    if (shares.length === 0) return
    revision.current++
    setFileParts((previous) => {
      const parts = new Map(previous.map((part) => [part.id, part]))
      for (const share of shares) parts.set(share.fileId, sharedFilePart(share))
      return [...parts.values()]
    })
  }, [])

  const removeFile = useCallback((id: string) => {
    revision.current++
    setFileParts((previous) => previous.filter((item) => item.id !== id))
    setOriginalFiles((previous) => omitKey(previous, id))
    setPastedText((previous) => omitKey(previous, id))
  }, [])

  const insertInline = useCallback(
    (id: string) => {
      const saved = pastedText[id]
      const editor = editorRef.current
      if (!saved || !editor) return
      const position = Math.min(saved.position, editor.state.doc.content.size)
      editor
        .chain()
        .setTextSelection(position)
        .insertContent(
          saved.text.replace(/\r\n?/g, '\n').replace(/\n/g, '\n\n'),
          { contentType: 'markdown' },
        )
        .focus()
        .run()
      removeFile(id)
    },
    [editorRef, pastedText, removeFile],
  )

  return {
    addFiles,
    addLargeTextPaste,
    addSharedFiles,
    clearAttachmentDraft,
    fileParts,
    files,
    getRevision: () => revision.current,
    insertInline,
    originalFiles,
    pastedText,
    removeFile,
    resetAttachments,
    restoreAttachments,
    prepareAttachmentMove,
    processing: processingKey === (draftKey ?? null),
    isRestored: !draftKey || restoredDraftKey === draftKey,
  }
}

function attachmentDraft(
  parts: PendingFilePart[],
  originals: Record<string, File>,
  pastedText: PastedText,
  retained?: Set<string>,
) {
  return parts.flatMap((part): ComposerAttachmentDraft[] => {
    if (part.share) return [{ id: part.id, share: part.share }]
    const file = originals[part.id]
    const pasted = pastedText[part.id]
    if (!file || (retained && !pasted && !retained.has(part.id))) return []
    return [{ id: part.id, file, pastePosition: pasted?.position }]
  })
}

type RestoredAttachmentDraft = {
  fileParts: PendingFilePart[]
  originalFiles: Record<string, File>
  pastedText: PastedText
}

type RestoredDraftFile = {
  part: PendingFilePart
  file?: File
  pastePosition?: number
}

function buildDraftFileItem(part: PendingFilePart, canInsertInline: boolean) {
  const share = part.share
  const file = buildFileItemFromPart(
    part,
    part.id,
    normalizeBrowserUrl(share?.url) ?? undefined,
    normalizeBrowserUrl(share?.previewUrl) ?? undefined,
    share?.shareUrl,
    share?.byteLength ?? undefined,
  )
  return { ...file, canInsertInline, imageDimensions: share?.imageDimensions }
}

async function restoreAttachmentDraft(
  draftKey: string,
): Promise<RestoredAttachmentDraft | null> {
  const saved = await readComposerAttachmentDraft(draftKey)
  const processed = await Promise.allSettled(
    saved.map(async (item): Promise<RestoredDraftFile> => {
      if ('share' in item) return { part: sharedFilePart(item.share) }
      const { id, file, pastePosition } = item
      const { part } = await processComposerFile(file, id)
      return { part, file, pastePosition }
    }),
  )
  const restored = processed.flatMap((result) =>
    result.status === 'fulfilled' ? [result.value] : [],
  )
  if (restored.length === 0) return null

  const pastedEntries = await Promise.allSettled(
    restored.flatMap(({ part, file, pastePosition }) =>
      !file || pastePosition === undefined
        ? []
        : [
            file
              .text()
              .then(
                (text) => [part.id, { text, position: pastePosition }] as const,
              ),
          ],
    ),
  )

  return {
    fileParts: restored.map(({ part }) => part),
    originalFiles: Object.fromEntries(
      restored.flatMap(({ part, file }) => (file ? [[part.id, file]] : [])),
    ),
    pastedText: Object.fromEntries(
      pastedEntries.flatMap((result) =>
        result.status === 'fulfilled' ? [result.value] : [],
      ),
    ),
  }
}

/** Assigns an occurrence ID independently of the processed file's content. */
async function processComposerFile(file: File, id = generateId()) {
  const processed = await processFileForUpload(file)
  return { ...processed, part: { ...processed.part, id } }
}

function omitKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _, ...rest } = record
  return rest
}
