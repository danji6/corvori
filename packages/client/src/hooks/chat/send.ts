import { useAccountId } from '@/hooks/account-scope'
import { useActiveAgent } from '@/hooks/chat/agent'
import type { ActiveAgent } from '@/hooks/chat/agent'
import { useUserProfile } from '@/hooks/chat/profile'
import { useActiveSession } from '@/hooks/chat/session'
import { generateId } from '@/lib'
import { normalizeBrowserUrl } from '@/lib/auth/site-url'
import type { MessageRole, PendingFilePart, PendingMessage } from '@/lib/chat'
import {
  type FileToUpload,
  startAttachmentSend,
} from '@/lib/chat/attachment-send-job'
import type { StagedAttachment } from '@/lib/chat/attachment-send-previews'
import {
  createOptimisticMessageId,
  hasMessageSend,
} from '@/lib/chat/message-uploads'
import type { SharedAttachment } from '@/lib/chat/types'
import { uploadAttachmentBlob } from '@/lib/chat/upload-attachment-blob'
import { api } from '@cv/convex/_generated/api'
import type { Doc, Id } from '@cv/convex/_generated/dataModel'
import type { MessageSender, ReplyQuote } from '@cv/convex/validators/messages'
import { parseFileMentions } from '@cv/core/mentions/parse'
import { parseShellCommand, unescapeShellPrefix } from '@cv/core/shell/command'
import type { WorkspaceLinkSnapshot } from '@cv/core/types/workspace'
import type { FileUIPart } from 'ai'
import type { OptimisticLocalStore } from 'convex/browser'
import { type ReactMutation, useAction, useMutation } from 'convex/react'
import type { FunctionArgs, FunctionReturnType } from 'convex/server'
import { useCallback } from 'react'

import { useParticipantNames } from './author-profile'
import { useIsWorkspaceAdmin } from './tools'

type WindowMessage = FunctionReturnType<
  typeof api.chat.messagesWindow
>['page'][number]

type ResolvedFileLink = {
  path: string
  snapshot?: WorkspaceLinkSnapshot<Id<'_storage'>>
}

type SendArgs = FunctionArgs<typeof api.chat.sendMessage> & {
  clientSendId: string
}

type UploadMeta = { mediaType: string; filename: string }

type MessageFile = FileUIPart & { attachmentId?: Id<'attachments'> }

type ResolveFileLinks = (args: {
  sessionId: Id<'sessions'>
  paths: string[]
}) => Promise<ResolvedFileLink[]>

export function useSendMessage() {
  const account = useAccountId()
  const session = useActiveSession()
  const profile = useUserProfile()
  const agent = useActiveAgent()
  const { user, assistant } = useParticipantNames(profile?._id, agent)
  const generateUploadUrl = useMutation(api.attachments.generateUploadUrl)
  const confirmAttachment = useMutation(api.attachments.confirm)
  const confirmImageAttachment = useAction(api.actions.attachments.confirmImage)
  const resolveFileLinks = useAction(api.actions.workspaces.resolveFileLinks)
  const isWorkspaceAdmin = useIsWorkspaceAdmin()
  const sendMutation = useMutation(api.chat.sendMessage)
  const begin = useMutation(api.chat.beginAttachmentSend)
  const renew = useMutation(api.chat.renewAttachmentSend)
  const discard = useMutation(api.chat.discardAttachmentSend)

  return useCallback(
    async (pending: PendingMessage, role?: MessageRole) => {
      if (!session) throw new Error('Chat session is unavailable')

      const prepared = prepareSend({
        pending,
        sessionId: session._id,
        role,
        profile,
        agent,
        user,
        assistant,
      })
      const links = captureFileLinks(() =>
        resolveMentionedFileLinks(
          prepared.args.content,
          session._id,
          isWorkspaceAdmin &&
            Boolean(session.workspace) &&
            !parseShellCommand(prepared.args.content),
          resolveFileLinks,
        ),
      )
      const { files, args } = prepared
      const deliver = async (
        attachments: StagedAttachment[],
        attachmentSendId?: Id<'attachmentSends'>,
      ) =>
        deliverMessage(sendMutation, prepared, {
          attachments,
          attachmentSendId,
          fileLinks: await links.read(),
        })

      if (!files.length) return deliver([])
      return startAttachmentSend({
        account,
        optimistic: optimisticUpload(prepared),
        files,
        register: async () => {
          const registration = await begin({
            sessionId: args.sessionId,
            clientSendId: args.clientSendId,
            occurrenceIds: files.map((file) => file.occurrenceId),
          })
          if ('pendingId' in registration) links.start()
          return registration
        },
        renew: (id) => renew({ id }),
        discard: (id) => discard({ id }),
        store: async (blob, mediaType, signal, progress) => {
          const url = normalizeBrowserUrl(await generateUploadUrl({}))
          if (!url) throw new Error('Upload URL is unavailable')
          return uploadAttachmentBlob(url, blob, mediaType, signal, progress)
        },
        confirm: async (input) =>
          input.mediaType.startsWith('image/')
            ? confirmImageAttachment(input)
            : { id: await confirmAttachment(input) },
        deliver: (id, attachments) => deliver(attachments, id),
      })
    },
    [
      account,
      session,
      sendMutation,
      generateUploadUrl,
      confirmAttachment,
      confirmImageAttachment,
      resolveFileLinks,
      isWorkspaceAdmin,
      profile,
      agent,
      user,
      assistant,
      begin,
      renew,
      discard,
    ],
  )
}

type SendSnapshotOptions = {
  pending: PendingMessage
  sessionId: Id<'sessions'>
  role?: MessageRole
  profile: Doc<'users'> | null
  agent: ActiveAgent | null
  user?: string | null
  assistant?: string | null
}

function prepareSend(options: SendSnapshotOptions) {
  const { pending, sessionId, profile, agent, user, assistant } = options
  const clientSendId = generateId()
  const role = options.role ?? pending.role ?? 'user'
  const reply = pending.replyTo?.target
  const args: SendArgs = {
    sessionId,
    clientSendId,
    content: pending.content.trim(),
    ...(role !== 'user' && { role }),
    ...(pending.silent && { silent: true }),
    ...(reply && {
      replyToId: reply.id,
      ...(reply.part && { replyToPart: reply.part }),
    }),
  }
  const id = createOptimisticMessageId(clientSendId)
  const sender = optimisticSender(role, profile, agent, id)
  const senderName = (sender.type === 'agent' ? assistant : user) ?? null
  return {
    args,
    parts: pending.files,
    files: localFilesForSend(pending, id),
    optimistic: (parts: MessageFile[]) =>
      buildOptimisticMessage(
        args,
        parts,
        { sender, senderName },
        id,
        pending.replyTo,
      ),
  }
}

type PreparedSend = ReturnType<typeof prepareSend>

function optimisticUpload({ files, parts, optimistic }: PreparedSend) {
  const local = new Map(
    files.map(({ occurrenceId, url, mediaType, filename }) => [
      occurrenceId,
      { type: 'file', url, mediaType, filename } satisfies MessageFile,
    ]),
  )
  return optimistic(
    parts.map((part) =>
      part.share ? sharedFilePreview(part.share) : local.get(part.id)!,
    ),
  )!
}

type Delivery = {
  attachments: StagedAttachment[]
  attachmentSendId?: Id<'attachmentSends'>
  fileLinks?: ResolvedFileLink[]
}

function deliverMessage(
  mutation: ReactMutation<typeof api.chat.sendMessage>,
  prepared: PreparedSend,
  { attachments, attachmentSendId, fileLinks }: Delivery,
) {
  const { args, files, parts } = prepared
  const confirmed = new Map(
    files.map((file, index) => [file.occurrenceId, attachments[index]]),
  )
  const optimistic = prepared.optimistic(
    parts.map((part) =>
      part.share
        ? sharedFilePreview(part.share)
        : confirmedPart(part, confirmed.get(part.id)!),
    ),
  )
  const references = parts.map((part) =>
    part.share
      ? { shareUrl: part.share.shareUrl }
      : { id: confirmed.get(part.id)!.id },
  )
  return mutation.withOptimisticUpdate((store) => {
    if (optimistic) optimisticallyInsertMessage(store, optimistic)
  })({
    ...args,
    ...(attachmentSendId && { attachmentSendId }),
    ...(references.length && { attachments: references }),
    ...(fileLinks !== undefined && { fileLinks }),
  })
}

/** Snapshots workspace links at send time and reuses them on delivery retry. */
function captureFileLinks(load: () => Promise<ResolvedFileLink[] | undefined>) {
  let snapshot: ReturnType<typeof load> | undefined
  function start() {
    if (!snapshot) {
      snapshot = load()
      void snapshot.catch(() => undefined)
    }
    return snapshot
  }
  return {
    start,
    async read() {
      try {
        return await start()
      } catch (error) {
        snapshot = undefined
        throw error
      }
    },
  }
}

function localFilesForSend(
  pending: PendingMessage,
  optimisticId: Id<'messages'>,
): FileToUpload[] {
  return pending.files.flatMap((part) => {
    if (part.share) return []
    const file = pending.originalFiles?.[part.id]
    if (!file) throw new Error('The original attachment is unavailable')
    const meta = fileMeta(part, file)
    return [
      {
        ...meta,
        occurrenceId: part.id,
        url: `attachment:${optimisticId}:${part.id}`,
        file,
      },
    ]
  })
}

function confirmedPart(
  part: PendingFilePart,
  { id }: StagedAttachment,
): MessageFile {
  return {
    type: 'file',
    url: `attachment:${id}`,
    attachmentId: id,
    mediaType: part.mediaType,
    filename: part.filename,
  }
}

function sharedFilePreview({
  mediaType,
  filename,
  url,
}: SharedAttachment): MessageFile {
  return {
    type: 'file',
    mediaType,
    filename,
    url: normalizeBrowserUrl(url) ?? url,
  }
}

function fileMeta(part: FileUIPart, original: File | undefined): UploadMeta {
  const mediaType =
    original?.type || part.mediaType || 'application/octet-stream'
  const filename =
    (original?.name || part.filename) ??
    `attachment.${mediaType.split('/')[1]?.split('+')[0] ?? 'bin'}`
  return { mediaType, filename }
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
  attribution: Pick<WindowMessage, 'sender' | 'senderName'>,
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
          toolCallId: args.clientSendId,
          state: 'input-available',
          input: { command },
        },
      ]
    : [...fileParts, ...(content ? [{ type: 'text', text: content }] : [])]

  return {
    _id: id,
    clientSendId: args.clientSendId,
    _creationTime: Date.now(),
    position: `~${id}`,
    sessionId: args.sessionId,
    role,
    ...attribution,
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
    if (!value || hasMessageSend(value.page, doc)) continue
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
  agent: ActiveAgent | null,
  fallbackId: Id<'messages'>,
): MessageSender {
  if (role === 'assistant' && agent) {
    return { type: 'agent', id: agent._id }
  }

  return {
    type: 'user',
    id: profile?._id ?? (fallbackId as unknown as Id<'users'>),
  }
}
