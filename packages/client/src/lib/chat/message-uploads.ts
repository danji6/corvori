import { useAccountId } from '@/hooks/account-scope'
import type { AttachmentUploadStatus } from '@/hooks/file-previews'
import type { Id } from '@cv/convex/_generated/dataModel'
import type { WindowMessage } from '@cv/convex/model/chat/queries'
import { useSyncExternalStore } from 'react'

const prefix = 'optimistic:'
const empty: WindowMessage[] = []
const uploadsBySession = new Map<string, WindowMessage[]>()
const listeners = new Set<() => void>()
const jobs = new Map<string, UploadJob>()

export type MessageUploadState = {
  files: Record<string, AttachmentUploadStatus | undefined>
  error?: string
  retry?: () => void
  discard?: () => void
}

type UploadJob = {
  account: string
  state: MessageUploadState
  close: () => void
}

export function createOptimisticMessageId(clientSendId: string) {
  return `${prefix}${clientSendId}` as Id<'messages'>
}

export function isOptimisticMessageId(id: string) {
  return id.startsWith(prefix)
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function publish() {
  listeners.forEach((listener) => listener())
}

function sessionKey(account: string, sessionId: Id<'sessions'>) {
  return JSON.stringify([account, sessionId])
}

export function showMessageUpload(
  account: string,
  message: WindowMessage,
  state: MessageUploadState,
  close: () => void,
) {
  const key = sessionKey(account, message.sessionId)
  jobs.set(message._id, { account, state, close })
  uploadsBySession.set(key, [...(uploadsBySession.get(key) ?? empty), message])
  publish()

  return {
    update(state: MessageUploadState) {
      if (!jobs.has(message._id)) return
      jobs.set(message._id, { account, state, close })
      publish()
    },
    finish() {
      jobs.delete(message._id)
      const remaining = (uploadsBySession.get(key) ?? empty).filter(
        (item) => item !== message,
      )
      if (remaining.length) uploadsBySession.set(key, remaining)
      else uploadsBySession.delete(key)
      publish()
    },
  }
}

/** Stops local transfers when their authenticated account leaves the app. */
export function closeAccountMessageUploads(account: string) {
  for (const job of jobs.values()) {
    if (job.account === account) job.close()
  }
}

export function useMessageUploads(sessionId: Id<'sessions'> | null) {
  const account = useAccountId()
  return useSyncExternalStore(
    subscribe,
    () =>
      sessionId
        ? (uploadsBySession.get(sessionKey(account, sessionId)) ?? empty)
        : empty,
    () => empty,
  )
}

export function useMessageUploadState(messageId: string | undefined) {
  const account = useAccountId()
  return useSyncExternalStore(
    subscribe,
    () => {
      const job = messageId ? jobs.get(messageId) : undefined
      return job?.account === account ? job.state : undefined
    },
    () => undefined,
  )
}

/** Shows each upload until the optimistic mutation or its server row appears. */
export function appendMessageUploads(
  page: WindowMessage[],
  uploads: WindowMessage[],
) {
  if (uploads.length === 0) return page

  const visible = uploads.filter((message) => !hasMessageSend(page, message))
  return visible.length > 0 ? [...page, ...visible] : page
}

export function hasMessageSend(page: WindowMessage[], message: WindowMessage) {
  const { _id, clientSendId } = message
  return page.some(
    (row) =>
      row._id === _id ||
      (clientSendId !== undefined && row.clientSendId === clientSendId),
  )
}
