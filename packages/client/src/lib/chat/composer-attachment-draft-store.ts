import { APP_ID } from '@cv/core/const'

import type { PendingFilePart, SharedAttachment } from './types'

const DATABASE_NAME = `${APP_ID}-composer-drafts`
const STORE_NAME = 'attachments'

/** Retains converted text and pasted attachment links with the draft. */
export type ComposerAttachmentDraft =
  | { id?: string; file: File; pastePosition?: number }
  | { id: string; share: SharedAttachment; pastePosition?: never }

export function sharedFilePart(share: SharedAttachment): PendingFilePart {
  return {
    type: 'file',
    id: share.fileId,
    filename: share.filename,
    mediaType: share.mediaType,
    url: `attachment:${share.fileId}`,
    share,
  }
}

type DraftRecord = {
  key: string
  attachments: ComposerAttachmentDraft[]
}

export async function readComposerAttachmentDraft(
  key: string,
): Promise<ComposerAttachmentDraft[]> {
  let db: IDBDatabase | undefined
  try {
    db = await openDatabase()
    const transaction = db.transaction(STORE_NAME, 'readonly')
    const record = await request<DraftRecord | undefined>(
      transaction.objectStore(STORE_NAME).get(key),
    )
    return record?.attachments ?? []
  } catch {
    return []
  } finally {
    db?.close()
  }
}

export async function writeComposerAttachmentDraft(
  key: string,
  attachments: ComposerAttachmentDraft[],
): Promise<void> {
  let db: IDBDatabase | undefined
  try {
    db = await openDatabase()
    const transaction = db.transaction(STORE_NAME, 'readwrite')
    const store = transaction.objectStore(STORE_NAME)
    if (attachments.length > 0)
      store.put({ key, attachments } satisfies DraftRecord)
    else store.delete(key)
    await transactionDone(transaction)
  } catch {
    // Best effort
  } finally {
    db?.close()
  }
}

export function clearComposerAttachmentDraft(key: string): Promise<void> {
  return writeComposerAttachmentDraft(key, [])
}

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB is unavailable'))
  }
  return new Promise((resolve, reject) => {
    const pending = indexedDB.open(DATABASE_NAME, 1)
    pending.onupgradeneeded = () => {
      if (!pending.result.objectStoreNames.contains(STORE_NAME)) {
        pending.result.createObjectStore(STORE_NAME, { keyPath: 'key' })
      }
    }
    pending.onsuccess = () => resolve(pending.result)
    pending.onerror = () => reject(pending.error)
  })
}

function request<T>(pending: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    pending.onsuccess = () => resolve(pending.result)
    pending.onerror = () => reject(pending.error)
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
}
