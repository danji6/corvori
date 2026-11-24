import type { api } from '@cv/convex/_generated/api'
import type { Doc, Id } from '@cv/convex/_generated/dataModel'
import type { SessionSummary } from '@cv/convex/model/session/types'
import type { TranscriptLinkPreview } from '@cv/convex/validators/linkPreviews'
import type { ReplyQuote } from '@cv/convex/validators/messages'
import type { TokenUsage } from '@cv/convex/validators/providers'
import type {
  ApproveToolArgs as CoreApproveToolArgs,
  CreateAgentArgs as CoreCreateAgentArgs,
  SessionListItem as CoreSessionListItem,
  SessionMember as CoreSessionMember,
  SessionParticipant as CoreSessionParticipant,
  UpdateAgentArgs as CoreUpdateAgentArgs,
  MessageRole,
} from '@cv/core/types'
import type { ChatStatus, FileUIPart, UIMessage } from 'ai'
import type { FunctionReturnType } from 'convex/server'

export type { UIMessage }
export type * from '@cv/core/types'

export type SessionMember = CoreSessionMember<
  Doc<'userSessions'>,
  Id<'avatars'>
>

export type SessionParticipant = CoreSessionParticipant<
  Id<'users'>,
  Id<'agents'>,
  Id<'avatars'>
>

export type SessionListItem = CoreSessionListItem<
  SessionSummary,
  Id<'users'>,
  Id<'agents'>,
  Id<'avatars'>
>

export type CreateAgentArgs = CoreCreateAgentArgs<Id<'agents'>>

export type UpdateAgentArgs = CoreUpdateAgentArgs<Id<'agents'>>

export type ApproveToolArgs = CoreApproveToolArgs<Id<'sessions'>>

export type UIAvatar = {
  thumbnail: string | null
  original: string | null
}

export type UsageTotals = Partial<TokenUsage>

export type UIMetadata = {
  usage: UsageTotals
}

export type UIMessageType = NonNullable<Doc<'messages'>['type']>

type MessageMetadata = NonNullable<Doc<'messages'>['metadata']>

export type PartMetadata = Pick<MessageMetadata, 'duration' | 'toolErrors'>

/** Loaded segment boundaries within a message's flattened parts. */
export type MessageSegmentInfo = {
  /** The server-side segment index (gaps allowed). */
  index: number
  /** How many of the message's flattened parts belong to this segment. */
  partCount: number
  /** Serialized size of the projected segment content. */
  sizeBytes: number
  linkPreviews?: TranscriptLinkPreview[]
}

export type MessageRecord = Pick<
  Doc<'messages'>,
  | 'clientSendId'
  | 'sender'
  | 'senderName'
  | 'type'
  | 'hidden'
  | 'extra'
  | 'replyTo'
  | 'selectedVersion'
  | 'versionCount'
  | 'hasChanges'
  | '_creationTime'
  | 'position'
> & {
  metadata?: Pick<MessageMetadata, 'error' | 'warnings' | 'usage'>
  /** Sum of the loaded segments' serialized sizes. */
  sizeBytes: number
  segments: MessageSegmentInfo[]
  /** Whether older segments of this message exist but aren't loaded. */
  hasOlderSegments: boolean
  hasNewerSegments: boolean
}

export type SessionMessage = {
  message: UIMessage
  type?: UIMessageType
}

export type SessionUpdate = Partial<Omit<Doc<'sessions'>, '_id'>>

export type MessagesEventData = {
  messages: SessionMessage[]
  messageIds: string[]
  messagesById: Map<string, SessionMessage>
  lastMessageId: string | null
  status: ChatStatus
  metadata?: UIMetadata
  summaryId?: string
}

export type { UIModel, UIModelConfig } from '@cv/core/types/providers'

export type SharedAttachment = NonNullable<
  FunctionReturnType<typeof api.attachments.previewShares>[number]
>

/** Identifies an attachment in a draft, including links to existing files. */
export type PendingFilePart = FileUIPart & {
  id: string
  share?: SharedAttachment
}

export type PendingMessage = {
  content: string
  files: PendingFilePart[]
  role?: MessageRole
  /** Original files keyed by attachment occurrence ID. */
  originalFiles?: Record<string, File>
  /** Converted text pastes keyed by attachment occurrence ID. */
  pastedText?: Record<string, { text: string; position: number }>
  silent?: boolean
  /** The message this one replies to, quoted above its content. */
  replyTo?: ReplyTarget
}

/** A quote that still points at its message, as the composer holds it. */
export type ReplyTarget = ReplyQuote & {
  target: NonNullable<ReplyQuote['target']>
}

export type ToolMetadata = {
  name: string
  label?: string
  description?: string
  category?: string
  requiresAdmin?: boolean
  requiresWorkspace?: boolean
}
