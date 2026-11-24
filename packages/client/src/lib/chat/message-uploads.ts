import type { Id } from '@cv/convex/_generated/dataModel'
import type { WindowMessage } from '@cv/convex/model/chat/queries'
import { useSyncExternalStore } from 'react'

const prefix = 'optimistic:'
const empty: WindowMessage[] = []
const uploadsBySession = new Map<Id<'sessions'>, WindowMessage[]>()
const listeners = new Set<() => void>()

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

function update(sessionId: Id<'sessions'>, uploads: WindowMessage[]) {
  if (uploads.length > 0) uploadsBySession.set(sessionId, uploads)
  else uploadsBySession.delete(sessionId)
  listeners.forEach((listener) => listener())
}

export function showMessageUpload(message: WindowMessage) {
  const { sessionId } = message
  update(sessionId, [...(uploadsBySession.get(sessionId) ?? empty), message])

  return {
    finish() {
      const uploads = uploadsBySession.get(sessionId) ?? empty
      update(
        sessionId,
        uploads.filter((item) => item !== message),
      )
    },
  }
}

export function useMessageUploads(sessionId: Id<'sessions'> | null) {
  return useSyncExternalStore(
    subscribe,
    () => (sessionId ? (uploadsBySession.get(sessionId) ?? empty) : empty),
    () => empty,
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
