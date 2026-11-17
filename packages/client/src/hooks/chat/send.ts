import { useActiveAgent } from '@/hooks/chat/agent'
import type { ActiveAgent } from '@/hooks/chat/agent'
import { useUserProfile } from '@/hooks/chat/profile'
import { useActiveSession } from '@/hooks/chat/session'
import { useSettings } from '@/hooks/chat/settings'
import { generateId } from '@/lib'
import { normalizeBrowserUrl } from '@/lib/auth/site-url'
import type { MessageRole, PendingFilePart, PendingMessage } from '@/lib/chat'
import {
  type StagedAttachment,
  keepAttachmentSendPreviews,
} from '@/lib/chat/attachment-send-previews'
import {
  createOptimisticMessageId,
  showMessageUpload,
} from '@/lib/chat/message-uploads'
import { api } from '@cv/convex/_generated/api'
import type { Doc, Id } from '@cv/convex/_generated/dataModel'
import type { ResolvedSettings } from '@cv/convex/model/defaults'
import type { ConfirmAttachmentArgs, ReplyQuote } from '@cv/convex/types'
import { attachmentReferences } from '@cv/core/attachments'
import { parseFileMentions } from '@cv/core/mentions/parse'
import { parseShellCommand, unescapeShellPrefix } from '@cv/core/shell/command'
import type { WorkspaceLinkSnapshot } from '@cv/core/types/workspace'
import { toDisplayName } from '@cv/core/utils/names'
import type { FileUIPart } from 'ai'
import type { OptimisticLocalStore } from 'convex/browser'
import { useAction, useMutation } from 'convex/react'
import type { FunctionArgs, FunctionReturnType } from 'convex/server'
import { useCallback } from 'react'

import { useIsWorkspaceAdmin } from './tools'

type WindowMessage = FunctionReturnType<
  typeof api.chat.messagesWindow
>['page'][number]

type ResolvedFileLink = {
  path: string
  snapshot?: WorkspaceLinkSnapshot<Id<'_storage'>>
}

type SendArgs = FunctionArgs<typeof api.chat.sendMessage>

type UploadMeta = { mediaType: string; filename: string }

type MessageFile = FileUIPart & { attachmentId?: Id<'attachments'> }

type StoreBlob = (blob: Blob, mediaType: string) => Promise<Id<'_storage'>>

type ConfirmAttachment = (
  args: Omit<ConfirmAttachmentArgs, 'sessionId'>,
) => Promise<Pick<StagedAttachment, 'id' | 'imageDimensions'>>

type ResolveFileLinks = (args: {
  sessionId: Id<'sessions'>
  paths: string[]
}) => Promise<ResolvedFileLink[]>

export function useSendMessage() {
  const session = useActiveSession()
  const settings = useSettings()
  const profile = useUserProfile()
  const agent = useActiveAgent()
  const generateUploadUrl = useMutation(api.attachments.generateUploadUrl)
  const confirmAttachment = useMutation(api.attachments.confirm)
  const confirmImageAttachment = useAction(api.actions.attachments.confirmImage)
  const removeAttachment = useMutation(api.attachments.remove)
  const resolveFileLinks = useAction(api.actions.workspaces.resolveFileLinks)
  const isWorkspaceAdmin = useIsWorkspaceAdmin()

  const sendMutation = useMutation(api.chat.sendMessage)

  return useCallback(
    async (pending: PendingMessage, role?: MessageRole) => {
      if (!session) throw new Error('Chat session is unavailable')
      const content = pending.content.trim()
      const messageRole = role ?? pending.role ?? 'user'
      const args: SendArgs = {
        sessionId: session._id,
        content,
        ...(messageRole !== 'user' ? { role: messageRole } : {}),
        ...(pending.silent ? { silent: true } : {}),
        ...(pending.replyTo && { replyToId: pending.replyTo.target.id }),
      }
      const optimisticId = createOptimisticMessageId()
      const localFiles = pending.files.map((part) =>
        localAttachment(part, pending.originalFiles?.[part.id], optimisticId),
      )

      const storeBlob: StoreBlob = async (blob, mediaType) => {
        const uploadUrl = normalizeBrowserUrl(await generateUploadUrl({}))
        if (!uploadUrl) throw new Error('Upload URL not available')
        const response = await fetch(uploadUrl, {
          method: 'POST',
          headers: { 'Content-Type': mediaType },
          body: blob,
        })
        if (!response.ok) {
          throw new Error(`Upload failed: ${response.statusText}`)
        }
        const { storageId } = (await response.json()) as {
          storageId: Id<'_storage'>
        }
        return storageId
      }

      const canResolveLinks =
        Boolean(session.workspace) &&
        isWorkspaceAdmin &&
        // Don't resolve `@path` links if this is a shell command
        parseShellCommand(content) === null

      let attachments: StagedAttachment[] = []
      const previews = localFiles.length
        ? keepAttachmentSendPreviews(localFiles)
        : undefined
      const optimistic = buildOptimisticMessage(
        args,
        localFiles.map(({ part }) => part),
        profile,
        settings,
        agent,
        optimisticId,
        pending.replyTo,
      )
      const upload =
        previews && optimistic ? showMessageUpload(optimistic) : undefined
      let sent = false
      try {
        const [uploads, links] = await Promise.allSettled([
          uploadFiles(
            pending.files,
            pending.originalFiles,
            storeBlob,
            async (args) => {
              const input = { ...args, sessionId: session._id }
              if (args.mediaType.startsWith('image/')) {
                return confirmImageAttachment(input)
              }
              return { id: await confirmAttachment(input) }
            },
            (id) => removeAttachment({ attachmentId: id }),
          ),
          resolveMentionedFileLinks(
            content,
            session._id,
            canResolveLinks,
            resolveFileLinks,
          ),
        ])
        if (uploads.status === 'rejected') throw uploads.reason
        attachments = uploads.value
        if (links.status === 'rejected') throw links.reason
        const attachmentLinks = attachmentReferences(content)
        const confirmedMessage = previews
          ? buildOptimisticMessage(
              args,
              attachments.map(confirmedFilePart),
              profile,
              settings,
              agent,
              optimisticId,
              pending.replyTo,
            )
          : optimistic
        previews?.confirm(attachments)
        if (attachments.length > 0) upload?.matchAttachment(attachments[0].id)
        const messageId = await sendMutation.withOptimisticUpdate((store) => {
          if (confirmedMessage)
            optimisticallyInsertMessage(store, confirmedMessage)
        })({
          ...args,
          ...(attachments.length > 0 && {
            attachments: attachments.map(({ id }) => ({ id })),
          }),
          ...(attachmentLinks.length > 0 ? { attachmentLinks } : {}),
          ...(links.value !== undefined ? { fileLinks: links.value } : {}),
        })
        sent = true
        return messageId
      } catch (error) {
        upload?.finish()
        await Promise.allSettled(
          attachments.map(({ id }) => removeAttachment({ attachmentId: id })),
        )
        throw error
      } finally {
        if (sent) upload?.finish()
        previews?.releaseWhenFinished(sent)
      }
    },
    [
      session,
      sendMutation,
      generateUploadUrl,
      confirmAttachment,
      confirmImageAttachment,
      removeAttachment,
      resolveFileLinks,
      isWorkspaceAdmin,
      profile,
      settings,
      agent,
    ],
  )
}

async function uploadFiles(
  files: PendingMessage['files'],
  originalFiles: Record<string, File> | undefined,
  storeBlob: StoreBlob,
  confirm: ConfirmAttachment,
  remove: (id: Id<'attachments'>) => Promise<unknown>,
): Promise<StagedAttachment[]> {
  const settled = await Promise.allSettled(
    files.map(async (part) => {
      const original = originalFiles?.[part.id]
      const meta = fileMeta(part, original)
      const isImage = meta.mediaType.startsWith('image/')
      const blob = original ?? (await dataUrlToBlob(part.url))

      const storageId = await storeBlob(blob, meta.mediaType)
      const previewStorageId =
        isImage && original
          ? await storeBlob(await dataUrlToBlob(part.url), 'image/jpeg')
          : undefined

      const confirmed = await confirm({
        storageId,
        previewStorageId,
        ...meta,
      })
      return {
        ...confirmed,
        ...meta,
        byteLength: blob.size,
      }
    }),
  )
  const uploaded = settled.flatMap((result) =>
    result.status === 'fulfilled' ? [result.value] : [],
  )
  const failed = settled.find((result) => result.status === 'rejected')
  if (failed?.status === 'rejected') {
    await Promise.allSettled(uploaded.map(({ id }) => remove(id)))
    throw failed.reason
  }
  return uploaded
}

function localAttachment(
  part: PendingFilePart,
  original: File | undefined,
  messageId: Id<'messages'>,
) {
  const meta = fileMeta(part, original)
  const url = `attachment:${messageId}:${part.id}`
  return {
    url,
    source: meta.mediaType.startsWith('image/')
      ? part.url
      : (original ?? part.url),
    byteLength: original?.size,
    part: { type: 'file', url, ...meta } satisfies MessageFile,
  }
}

function confirmedFilePart({ id, mediaType, filename }: StagedAttachment) {
  return {
    type: 'file',
    url: `attachment:${id}`,
    attachmentId: id,
    mediaType,
    filename,
  } satisfies MessageFile
}

function fileMeta(part: FileUIPart, original: File | undefined): UploadMeta {
  const mediaType =
    original?.type || part.mediaType || 'application/octet-stream'
  const filename =
    original?.name ??
    part.filename ??
    `attachment.${mediaType.split('/')[1]?.split('+')[0] ?? 'bin'}`
  return { mediaType, filename }
}

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const response = await fetch(dataUrl)
  return response.blob()
}

async function resolveMentionedFileLinks(
  content: string,
  sessionId: Id<'sessions'>,
  canResolve: boolean,
  resolveFileLinks: ResolveFileLinks,
): Promise<ResolvedFileLink[] | undefined> {
  if (!canResolve) return undefined
  const paths = parseFileMentions(content)
  if (paths.length === 0) return []
  return resolveFileLinks({ sessionId, paths })
}

function buildOptimisticMessage(
  args: SendArgs,
  fileParts: MessageFile[],
  profile: Doc<'users'> | null,
  settings: ResolvedSettings | undefined,
  agent: ActiveAgent | null,
  id: Id<'messages'>,
  replyTo?: ReplyQuote,
) {
  const content = unescapeShellPrefix(args.content).trim()
  if (!content && fileParts.length === 0) return

  const role = args.role ?? 'user'
  // `$ <command>` renders as a shell block
  const command = role === 'user' ? parseShellCommand(args.content) : null
  const parts = command
    ? [
        {
          type: 'tool-shell',
          toolCallId: generateId(),
          state: 'input-available',
          input: { command },
        },
      ]
    : [...fileParts, ...(content ? [{ type: 'text', text: content }] : [])]
  return {
    _id: id,
    _creationTime: Date.now(),
    position: `~${id}`,
    sessionId: args.sessionId,
    role,
    ...optimisticSender(role, profile, settings, agent, id),
    // Shell commands run in place and never carry a quote
    ...(replyTo && !command && { replyTo }),
    status: command ? 'processing' : 'done',
    selectedVersion: 1,
    versionCount: 1,
    segments: [{ segmentIndex: 0, parts, sizeBytes: 0 }],
    sizeBytes: 0,
    hasOlderSegments: false,
    hasNewerSegments: false,
  } as unknown as WindowMessage
}

/** Append to the live message windows for this session. */
function optimisticallyInsertMessage(
  store: OptimisticLocalStore,
  doc: WindowMessage,
) {
  for (const query of store.getAllQueries(api.chat.messagesWindow)) {
    if (query.args.sessionId !== doc.sessionId || query.args.anchor !== null) {
      continue
    }
    const value = query.value
    if (!value) continue
    store.setQuery(api.chat.messagesWindow, query.args, {
      ...value,
      page: [...value.page, doc],
      atTail: true,
    })
  }
}

function optimisticSender(
  role: MessageRole,
  profile: Doc<'users'> | null,
  settings: ResolvedSettings | undefined,
  agent: ActiveAgent | null,
  fallbackId: Id<'messages'>,
) {
  // Assistant messages are sent on behalf of the active agent.
  if (role === 'assistant' && agent) {
    return {
      sender: { type: 'agent', id: agent._id },
      senderName: agent.name,
      senderAvatarId: agent.avatarId,
    }
  }

  const sender = {
    type: 'user',
    id: profile?._id ?? (fallbackId as unknown as Id<'users'>),
  }

  // System messages carry no sender identity (no header, no name prefix).
  if (role === 'system') return { sender }

  return {
    sender,
    senderName: toDisplayName(settings?.displayName),
    senderAvatarId: settings?.avatarId,
  }
}
