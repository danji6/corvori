import { createLocalAttachmentPreview } from '@/lib/chat/local-attachment-preview'
import { useEffect, useRef, useState } from 'react'

import type { LocalFilePreview } from './file-previews'

type OwnedPreview = NonNullable<ReturnType<typeof createLocalAttachmentPreview>>

/** Retains each local object's URL while its file is present in the draft. */
export function useLocalFilePreviews(files: Record<string, File>) {
  const owned = useRef(new Map<string, { file: File; local?: OwnedPreview }>())
  const [previews, setPreviews] = useState<Record<string, LocalFilePreview>>({})

  useEffect(() => {
    const current = owned.current
    let changed = false
    for (const [id, entry] of current) {
      if (files[id] === entry.file) continue
      if (entry.local) {
        entry.local.release()
        changed = true
      }
      current.delete(id)
    }
    for (const [id, file] of Object.entries(files)) {
      if (!current.has(id)) {
        const local = createLocalAttachmentPreview(file)
        if (local) changed = true
        current.set(id, { file, local })
      }
    }
    if (!changed) return
    setPreviews(
      Object.fromEntries(
        [...current].flatMap(([id, { local }]) =>
          local ? [[id, local.preview]] : [],
        ),
      ),
    )
  }, [files])

  useEffect(
    () => () => {
      for (const { local } of owned.current.values()) local?.release()
      owned.current.clear()
    },
    [],
  )

  return previews
}
