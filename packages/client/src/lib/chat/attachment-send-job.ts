import type { AttachmentUploadStatus } from '@/hooks/file-previews'
import { extractErrorMessage } from '@/lib/errors'
import type { Id } from '@cv/convex/_generated/dataModel'
import type { WindowMessage } from '@cv/convex/model/chat/queries'
import type { ConfirmAttachmentArgs } from '@cv/convex/validators/attachments'

import {
  type StagedAttachment,
  keepAttachmentSendPreviews,
} from './attachment-send-previews'
import { getAttachmentThumbnail } from './local-attachment-preview'
import { showMessageUpload } from './message-uploads'

type PendingId = Id<'attachmentSends'>
type StorageId = Id<'_storage'>

export type FileToUpload = {
  url: string
  file: File
  occurrenceId: string
  filename: string
  mediaType: string
}

type UploadEntry = FileToUpload & {
  status?: AttachmentUploadStatus
  confirmed?: StagedAttachment
  active?: boolean
  storageId?: StorageId
  previewStorageId?: StorageId
}

type UploadJobOptions = {
  account: string
  optimistic: WindowMessage
  files: FileToUpload[]
  register: () => Promise<
    { pendingId: PendingId } | { messageId: Id<'messages'> }
  >
  renew: (id: PendingId) => Promise<boolean>
  discard: (id: PendingId) => Promise<unknown>
  store: (
    file: Blob,
    mediaType: string,
    signal: AbortSignal,
    progress?: (fraction?: number) => void,
  ) => Promise<StorageId>
  confirm: (attachment: ConfirmAttachmentArgs) => Promise<StagedAttachment>
  deliver: (
    id: PendingId,
    attachments: StagedAttachment[],
  ) => Promise<Id<'messages'>>
}

const HEARTBEAT_MS = 30_000

/** Accepts an attachment message and transfers its remaining work to the tab. */
export async function startAttachmentSend(options: UploadJobOptions) {
  const job = new AttachmentSendJob(options)
  return job.start()
}

class AttachmentSendJob {
  private entries: UploadEntry[]
  private previews
  private row
  private id: PendingId | undefined
  private controller = new AbortController()
  private heartbeat: ReturnType<typeof setInterval> | undefined
  private renewing = false
  private finished = false
  private busy = false
  private error: string | undefined

  constructor(private options: UploadJobOptions) {
    this.entries = options.files.map((file) => ({
      ...file,
      status: { phase: 'queued' },
    }))
    this.previews = keepAttachmentSendPreviews(options.files)
    this.row = showMessageUpload(
      options.account,
      options.optimistic,
      {
        files: this.statuses(),
      },
      () => this.finish(false),
    )
  }

  async start() {
    try {
      const result = await this.options.register()
      if (this.finished) throw new Error('Attachment send was interrupted')
      if ('messageId' in result) {
        this.finish(true)
        return result.messageId
      }
      this.id = result.pendingId
      this.heartbeat = setInterval(() => void this.renew(), HEARTBEAT_MS)
      this.startTransfers(this.entries)
      return this.options.optimistic._id
    } catch (error) {
      this.finish(false)
      throw error
    }
  }

  private async renew() {
    const id = this.id
    if (!id || this.renewing) return
    this.renewing = true
    try {
      if (
        !(await this.options.renew(id)) &&
        this.id === id &&
        !this.busy &&
        !this.finished
      ) {
        this.resetReservation()
        this.error = 'Attachment send expired. Retry to upload the files again.'
        this.update()
      }
    } catch {
      // Convex may reconnect before the current lease runs out.
    } finally {
      this.renewing = false
    }
  }

  private resetReservation() {
    this.id = undefined
    this.controller.abort()
    this.controller = new AbortController()
    this.entries = this.options.files.map((file) => ({ ...file }))
  }

  private startTransfers(entries: UploadEntry[]) {
    for (const entry of entries) {
      if (!entry.confirmed && !entry.active) void this.transfer(entry)
    }
    this.update()
    void this.deliver()
  }

  private async transfer(entry: UploadEntry) {
    const id = this.id
    if (!id) return
    const { signal } = this.controller
    entry.active = true
    entry.status = { phase: 'uploading' }
    try {
      await this.storeFile(entry, signal)
      signal.throwIfAborted()
      entry.confirmed = await this.confirmFile(id, entry)
      if (!signal.aborted) entry.status = undefined
    } catch (error) {
      if (!signal.aborted) {
        entry.status = {
          phase: 'failed',
          error: extractErrorMessage(error, 'Upload failed'),
          retry: () => void this.retry(entry),
        }
      }
    } finally {
      entry.active = false
      if (!signal.aborted) {
        this.update()
        void this.deliver()
      }
    }
  }

  private async storeFile(entry: UploadEntry, signal: AbortSignal) {
    entry.storageId ??= await this.options.store(
      entry.file,
      entry.mediaType,
      signal,
      (fraction) => {
        if (signal.aborted) return
        entry.status = { phase: 'uploading', fraction }
        this.update()
      },
    )
    signal.throwIfAborted()
    entry.status = { phase: 'finishing' }
    this.update()
    if (!entry.mediaType.startsWith('image/') || entry.previewStorageId) return
    const thumbnail = await getAttachmentThumbnail(entry.file)
    if (thumbnail && !signal.aborted) {
      entry.previewStorageId = await this.options.store(
        thumbnail,
        'image/jpeg',
        signal,
      )
    }
  }

  private confirmFile(id: PendingId, entry: UploadEntry) {
    return this.options.confirm({
      sessionId: this.options.optimistic.sessionId,
      pendingSend: { id, occurrenceId: entry.occurrenceId },
      filename: entry.filename,
      mediaType: entry.mediaType,
      storageId: entry.storageId!,
      previewStorageId: entry.previewStorageId,
    })
  }

  private async deliver() {
    if (this.busy || this.finished || !this.id) return
    const confirmed = this.entries.flatMap((entry) =>
      entry.confirmed ? [entry.confirmed] : [],
    )
    if (confirmed.length !== this.entries.length) return
    this.busy = true
    this.update()
    try {
      this.previews.confirm(confirmed)
      await this.options.deliver(this.id, confirmed)
      this.finish(true)
    } catch (error) {
      this.error = extractErrorMessage(error, 'Could not deliver the message')
    } finally {
      this.busy = false
      if (!this.finished) this.update()
    }
  }

  private async retry(entry?: UploadEntry) {
    if (this.busy || this.finished || entry?.active) return
    this.busy = true
    this.error = undefined
    this.update()
    let entries: UploadEntry[] | undefined
    try {
      const result = await this.options.register()
      if (this.finished) return
      if ('messageId' in result) {
        this.finish(true)
        return
      }
      const sameReservation = this.id === result.pendingId
      if (!sameReservation) this.resetReservation()
      this.id = result.pendingId
      entries = entry && sameReservation ? [entry] : this.entries
    } catch (error) {
      this.error = extractErrorMessage(error, 'Could not retry the message')
    } finally {
      this.busy = false
      if (!this.finished) this.update()
    }
    if (entries) this.startTransfers(entries)
  }

  private async discard() {
    if (this.busy || this.finished) return
    this.busy = true
    this.controller.abort()
    for (const entry of this.entries) {
      if (entry.active) entry.status = undefined
    }
    this.update()
    try {
      if (this.id) await this.options.discard(this.id)
      this.finish(false)
    } catch (error) {
      this.controller = new AbortController()
      this.error = extractErrorMessage(error, 'Could not discard the message')
    } finally {
      this.busy = false
      if (!this.finished) this.update()
    }
  }

  private statuses() {
    return Object.fromEntries(
      this.entries.map(({ url, status }) => [url, status]),
    )
  }

  private update() {
    this.row.update({
      files: this.statuses(),
      error: this.error,
      retry: this.error && !this.busy ? () => void this.retry() : undefined,
      discard: this.busy ? undefined : () => void this.discard(),
    })
  }

  private finish(sent: boolean) {
    if (this.finished) return
    this.finished = true
    clearInterval(this.heartbeat)
    this.controller.abort()
    this.row.finish()
    this.previews.releaseWhenFinished(sent)
  }
}
