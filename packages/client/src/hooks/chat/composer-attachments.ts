import { useAccountId } from '@/hooks/account-scope'
import type { FileItem } from '@/hooks/file-previews'
import { useLocalFilePreviews } from '@/hooks/local-file-previews'
import { normalizeBrowserUrl } from '@/lib/auth/site-url'
import {
  type ComposerAttachmentDraft,
  clearComposerAttachmentDraft,
  readComposerAttachmentDraft,
  sharedFilePart,
  writeComposerAttachmentDraft,
} from '@/lib/chat/composer-attachment-draft-store'
import { describeUpload } from '@/lib/chat/io'
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
  nextOrder: number
  order: Map<string, number>
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
      nextOrder: 0,
      order: new Map(),
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

  const localPreviews = useLocalFilePreviews(originalFiles)
  const files = useMemo<FileItem[]>(
    () =>
      fileParts.map((part) => ({
        ...buildDraftFileItem(
          part,
          part.id in pastedText,
          originalFiles[part.id],
        ),
        localPreview: localPreviews[part.id],
      })),
    [fileParts, originalFiles, pastedText, localPreviews],
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
    attachmentQueue.current?.order.clear()
    filePartsRef.current = []
    setFileParts([])
    setOriginalFiles({})
    setPastedText({})
  }, [])

  const clearAttachmentDraft = useCallback(() => {
    if (draftKey) void clearComposerAttachmentDraft(draftKey)
  }, [draftKey])

  const insertBatch = useCallback(
    (queue: AttachmentQueue, order: number, parts: PendingFilePart[]) => {
      if (queue.signal.aborted || !parts.length) return
      for (const part of parts) {
        if (!queue.order.has(part.id)) queue.order.set(part.id, order)
      }
      revision.current++
      setFileParts((previous) => {
        const unique = new Map(previous.map((part) => [part.id, part]))
        for (const part of parts) unique.set(part.id, part)
        const position = (part: PendingFilePart) =>
          queue.order.get(part.id) ?? -1
        return [...unique.values()].sort((a, b) => position(a) - position(b))
      })
    },
    [],
  )

  const addFiles = useCallback(
    async (picked: ComposerFileBatch) => {
      const queue = attachmentQueue.current
      if (!queue) return false
      const order = queue.nextOrder++
      const isDeferred = !Array.isArray(picked)
      if (isDeferred) {
        queue.pending++
        setProcessingKey(draftKey ?? null)
      }
      try {
        const files = Array.isArray(picked) ? picked : await picked
        if (queue.signal.aborted || !files.length) return false
        const parts = files.map((file) => describeComposerFile(file))
        insertBatch(queue, order, parts)
        setOriginalFiles((previous) => ({
          ...previous,
          ...Object.fromEntries(
            parts.map((part, index) => [part.id, files[index]]),
          ),
        }))
        return true
      } catch (error) {
        if (!queue.signal.aborted) toastError(error, 'Failed to attach files')
        return false
      } finally {
        if (
          isDeferred &&
          --queue.pending === 0 &&
          attachmentQueue.current === queue
        ) {
          setProcessingKey(undefined)
        }
      }
    },
    [draftKey, insertBatch],
  )

  const addLargeTextPaste = useCallback(
    (text: string, position: number) => {
      const queue = attachmentQueue.current
      if (!queue || queue.signal.aborted) return
      const filename = suffixFilename('pasted-text.txt', attachmentNameSuffix())
      const file = new File([text], filename, {
        type: 'text/plain;charset=utf-8',
      })
      const part = describeComposerFile(file)
      insertBatch(queue, queue.nextOrder++, [part])
      setOriginalFiles((previous) => ({ ...previous, [part.id]: file }))
      setPastedText((previous) => ({
        ...previous,
        [part.id]: { text, position },
      }))
    },
    [insertBatch],
  )

  const addSharedFiles = useCallback(
    (shares: SharedAttachment[]) => {
      const queue = attachmentQueue.current
      if (queue)
        insertBatch(queue, queue.nextOrder++, shares.map(sharedFilePart))
    },
    [insertBatch],
  )

  const removeFile = useCallback((id: string) => {
    revision.current++
    setFileParts((previous) => previous.filter((item) => item.id !== id))
    setOriginalFiles((previous) => omitKey(previous, id))
    attachmentQueue.current?.order.delete(id)
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

function buildDraftFileItem(
  part: PendingFilePart,
  canInsertInline: boolean,
  originalFile?: File,
) {
  const share = part.share
  const file = buildFileItemFromPart(
    part,
    part.id,
    normalizeBrowserUrl(share?.url) ?? undefined,
    normalizeBrowserUrl(share?.previewUrl) ?? undefined,
    share?.shareUrl,
    share?.byteLength ?? originalFile?.size,
  )
  return {
    ...file,
    originalFile,
    canInsertInline,
    imageDimensions: share?.imageDimensions,
  }
}

async function restoreAttachmentDraft(
  draftKey: string,
): Promise<RestoredAttachmentDraft | null> {
  const saved = await readComposerAttachmentDraft(draftKey)
  const restored = saved.map((item): RestoredDraftFile => {
    if ('share' in item) return { part: sharedFilePart(item.share) }
    const { id, file, pastePosition } = item
    return { part: describeComposerFile(file, id), file, pastePosition }
  })
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

/** Assigns an occurrence ID independently of the local file contents. */
function describeComposerFile(file: File, id = generateId()) {
  return { ...describeUpload(file, id), id }
}

function omitKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _, ...rest } = record
  return rest
}
