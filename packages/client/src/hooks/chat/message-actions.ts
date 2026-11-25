import { useMessageStore } from '@/hooks/chat/messages'
import { useActiveSession } from '@/hooks/chat/session'
import { useStreamStore } from '@/hooks/chat/stream'
import type { PartAddress } from '@/lib/chat/parts'
import { toastError } from '@/lib/notifications'
import { api } from '@cv/convex/_generated/api'
import type { Id } from '@cv/convex/_generated/dataModel'
import type { DeleteMessageAttachmentArgs } from '@cv/convex/validators/messages'
import { linkPreviewUrls } from '@cv/core/utils/markdown-links'
import { serializedSize } from '@cv/core/utils/size'
import type { OptimisticLocalStore } from 'convex/browser'
import { useMutation } from 'convex/react'
import type { FunctionReturnType } from 'convex/server'
import { useCallback } from 'react'

type WindowMessage = FunctionReturnType<
  typeof api.chat.messagesWindow
>['page'][number]

export function useAbortStream() {
  const session = useActiveSession()
  const streamStore = useStreamStore()

  const stopMutation = useMutation(api.chat.stopStream).withOptimisticUpdate(
    (store, { sessionId, execution }) => {
      if (!execution) return
      const args = { sessionId }
      const stream = store.getQuery(api.chat.getActiveStream, args)
      if (
        stream?._id !== execution.streamId ||
        stream.generation !== execution.generation
      ) {
        return
      }
      store.setQuery(api.chat.getActiveStream, args, {
        ...stream,
        status: 'stopping',
      })
    },
  )

  return useCallback(() => {
    const stream = streamStore.getStream()
    if (!session || stream?.status === 'stopping') return
    stopMutation({
      sessionId: session._id,
      execution: stream
        ? { streamId: stream._id, generation: stream.generation }
        : undefined,
    }).catch(console.error)
  }, [session, stopMutation, streamStore])
}

export function useDeleteMessage() {
  const messageStore = useMessageStore()
  const deleteMutation = useMutation(
    api.chat.deleteMessage,
  ).withOptimisticUpdate((store, { messageId }) => {
    updateMessagePages(store, (page) =>
      page.filter((message) => message._id !== messageId),
    )
  })

  return useCallback(
    (id: string) => {
      deleteMutation({ messageId: id as Id<'messages'> }).catch(console.error)
      // Manual deletion needed here (see evict)
      messageStore.evict(id)
    },
    [deleteMutation, messageStore],
  )
}

export function useDeleteMessagesFrom() {
  const deleteMutation = useMutation(
    api.chat.deleteMessagesFrom,
  ).withOptimisticUpdate((store, { messageId }) => {
    const queries = store.getAllQueries(api.chat.messagesWindow)
    const owner = queries.find((query) =>
      query.value?.page.some((message) => message._id === messageId),
    )
    const anchor = owner?.value?.page.find(
      (message) => message._id === messageId,
    )
    if (!owner || !anchor) return

    for (const query of queries) {
      if (!query.value || query.args.sessionId !== owner.args.sessionId) {
        continue
      }
      const page = query.value.page.filter(
        (message) => message.position < anchor.position,
      )
      if (page.length === query.value.page.length) continue
      store.setQuery(api.chat.messagesWindow, query.args, {
        ...query.value,
        page,
        hasNewer: false,
        atTail: true,
      })
    }
  })

  return useCallback(
    (id: string) => {
      deleteMutation({ messageId: id as Id<'messages'> }).catch(console.error)
    },
    [deleteMutation],
  )
}

export function useEditMessage() {
  const editMutation = useMutation(api.chat.editMessage).withOptimisticUpdate(
    (store, { messageId, content }) => {
      if (content === undefined) return

      updateMessagePages(store, (page) =>
        page.map((message) => {
          if (message._id !== messageId) return message
          const parts = [{ type: 'text', text: content }]
          const saved = message.segments.flatMap(
            (segment) => segment.linkPreviews ?? [],
          )
          const previews = saved.length
            ? linkPreviewUrls(content)
                .map((url) => saved.find((entry) => entry.url === url))
                .filter((entry) => entry !== undefined)
            : []
          const sizeBytes =
            serializedSize(parts) +
            (previews.length ? serializedSize(previews) : 0)
          return {
            ...message,
            segments: [
              {
                segmentIndex: 0,
                parts,
                sizeBytes,
                ...(previews.length && { linkPreviews: previews }),
              },
            ],
            sizeBytes,
            hasOlderSegments: false,
            hasNewerSegments: false,
          }
        }),
      )
    },
  )

  return useCallback(
    (id: string, content?: string, removeReplyQuote?: true) =>
      editMutation({
        messageId: id as Id<'messages'>,
        content,
        removeReplyQuote,
      }),
    [editMutation],
  )
}

export function useEditMessagePart() {
  const editMutation = useMutation(
    api.chat.editMessagePart,
  ).withOptimisticUpdate(
    (store, { messageId, segmentIndex, partIndex, text }) => {
      updateMessagePages(store, (page) =>
        page.map((message) =>
          message._id === messageId
            ? {
                ...message,
                segments: message.segments.map((segment) =>
                  segment.segmentIndex === segmentIndex
                    ? {
                        ...segment,
                        parts: segment.parts.map((part, i) =>
                          i === partIndex
                            ? { ...(part as object), text }
                            : part,
                        ),
                      }
                    : segment,
                ),
              }
            : message,
        ),
      )
    },
  )

  return useCallback(
    (id: string, address: PartAddress, text: string, removeReplyQuote?: true) =>
      editMutation({
        messageId: id as Id<'messages'>,
        segmentIndex: address.segmentIndex,
        partIndex: address.partIndex,
        text,
        removeReplyQuote,
      }),
    [editMutation],
  )
}

export function useDeleteMessageParts() {
  const messageStore = useMessageStore()
  const deleteMutation = useMutation(
    api.chat.deleteMessageParts,
  ).withOptimisticUpdate((store, { messageId, addresses, from }) => {
    const explicit = new Set(
      addresses.map(
        ({ segmentIndex, partIndex }) => `${segmentIndex}:${partIndex}`,
      ),
    )
    const shouldRemove = (segmentIndex: number, partIndex: number) => {
      if (explicit.has(`${segmentIndex}:${partIndex}`)) return true
      if (!from) return false
      return (
        segmentIndex > from.segmentIndex ||
        (segmentIndex === from.segmentIndex && partIndex >= from.partIndex)
      )
    }
    updateMessagePages(store, (page) =>
      page.flatMap((message) => {
        if (message._id !== messageId) return [message]
        const segments = message.segments
          .map((segment) => ({
            ...segment,
            parts: segment.parts.filter(
              (_, i) => !shouldRemove(segment.segmentIndex, i),
            ),
          }))
          .filter((segment) => segment.parts.length > 0)
        return segments.length === 0 ? [] : [{ ...message, segments }]
      }),
    )
  })

  return useCallback(
    (id: string, addresses: PartAddress[], from?: PartAddress) => {
      deleteMutation({ messageId: id as Id<'messages'>, addresses, from })
        .then((deletedMessage) => {
          if (deletedMessage) messageStore.evict(id)
        })
        .catch(console.error)
    },
    [deleteMutation, messageStore],
  )
}

export function useDeleteMessageAttachment() {
  const messageStore = useMessageStore()
  const remove = useMutation(api.chat.deleteMessageAttachment)

  return useCallback(
    async (args: DeleteMessageAttachmentArgs) => {
      try {
        if (await remove(args)) messageStore.evict(args.messageId)
      } catch (error) {
        toastError(error, 'Could not delete the attachment.')
      }
    },
    [messageStore, remove],
  )
}

export function useRetryMessage() {
  const retry = useMutation(api.chat.retryMessage)

  return useCallback(
    (id: string) => {
      retry({ messageId: id as Id<'messages'> }).catch(console.error)
    },
    [retry],
  )
}

export function useSelectMessageVersion() {
  const select = useMutation(api.chat.selectMessageVersion)

  return useCallback(
    (id: string, version: number) => {
      select({ messageId: id as Id<'messages'>, version }).catch(console.error)
    },
    [select],
  )
}

function updateMessagePages(
  store: OptimisticLocalStore,
  updatePage: (page: WindowMessage[]) => WindowMessage[],
) {
  for (const query of store.getAllQueries(api.chat.messagesWindow)) {
    const value = query.value
    if (!value) continue
    const page = updatePage(value.page)
    if (page === value.page) continue
    store.setQuery(api.chat.messagesWindow, query.args, { ...value, page })
  }
}
