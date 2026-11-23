import { CodeAppearanceContext } from '@/components/markdown/code-appearance'
import {
  useActiveSession,
  useAttachmentIds,
  useChatMessage,
  useIsMessageStreaming,
  useMessageAppearance,
  useUserProfile,
} from '@/hooks/chat'
import { useIsAwaitingVisibleContinuation } from '@/hooks/chat/messages'
import {
  canMutateMessage,
  extractTextFromMessage,
  isEditableMessage,
  messageStructureSignature,
  useScopedAppearance,
} from '@/lib/chat'
import type { MessageRecord, PartMetadata } from '@/lib/chat'
import { type MessageRow, segmentGroupsFor } from '@/lib/chat/rows'
import { messageDisplayRole } from '@/lib/chat/sender-groups'
import { cn, formatDuration, isTouchDevice } from '@/lib/utils'
import { toDisplayName } from '@cv/core/utils/names'
import { type UIMessage, isReasoningUIPart } from 'ai'
import { memo, useMemo, useRef } from 'react'

import { ChangesSummary } from './changes/changes-summary'
import { ContextDivider } from './context-divider'
import { ErrorBlock } from './error-block'
import { GrowOnly } from './grow-only'
import { HiddenChip } from './hidden-chip'
import { MessageContext } from './message-context'
import { MessageContextMenu } from './message-context-menu'
import { MessageHeader } from './message-header'
import {
  highlightTargetForRow,
  useMessageHighlightRef,
} from './message-highlight-context'
import { MessageVersionSwitcher } from './message-version-switcher'
import { NoteGroupBlock } from './note-group-block'
import { PresenceNotice } from './presence-notice'
import { ReasoningHeader } from './reasoning-header'
import { RenderGroup } from './render-group'
import { ReplyQuoteCard } from './reply-quote'
import { WorkBlock } from './work-block'

export type MessageRowViewProps = {
  row: MessageRow
}

export const MessageRowView = memo(function MessageRowView({
  row,
}: MessageRowViewProps) {
  const { message, isLast, messageMeta, partMeta } = useChatMessage(
    row.kind === 'header'
      ? (row.reasoning?.messageId ?? row.messageId)
      : row.messageId,
  )

  if (!message) return null

  if (row.kind === 'note-group') return <NoteGroupBlock row={row} />

  if (row.kind === 'hidden') {
    return (
      <HiddenChip
        message={message}
        record={messageMeta}
        placement={row.placement}
      />
    )
  }

  if (row.kind === 'presence') {
    return <PresenceNotice message={message} record={messageMeta} />
  }

  return (
    <RowShell message={message} messageMeta={messageMeta} row={row}>
      {row.kind === 'context-reset' ? (
        <ContextResetRow messageId={message.id} />
      ) : row.kind === 'header' ? (
        <HeaderRow row={row} message={message} messageMeta={messageMeta} />
      ) : row.kind === 'reply' ? (
        messageMeta?.replyTo && (
          <ReplyQuoteCard messageId={message.id} quote={messageMeta.replyTo} />
        )
      ) : row.kind === 'group' ? (
        <GroupRow
          row={row}
          message={message}
          messageMeta={messageMeta}
          partMeta={partMeta}
        />
      ) : row.kind === 'work' ? (
        <WorkBlock
          row={row}
          message={message}
          record={messageMeta}
          toolErrors={partMeta?.toolErrors}
        />
      ) : row.kind === 'footer' ? (
        <FooterRow
          duration={row.duration}
          message={message}
          messageMeta={messageMeta}
          isLast={isLast}
        />
      ) : null}
    </RowShell>
  )
})

function ContextResetRow({ messageId }: { messageId: string }) {
  const ref = useMessageHighlightRef(messageId)

  return (
    <div
      ref={ref}
      data-slot="context-reset"
      data-message-id={messageId}
      className="w-full"
    >
      <ContextDivider label="Context reset" />
    </div>
  )
}

type RowShellProps = {
  message: UIMessage
  messageMeta?: MessageRecord
  row: MessageRow
  children: React.ReactNode
}

function RowShell({ message, messageMeta, row, children }: RowShellProps) {
  const rowRef = useRef<HTMLDivElement>(null)
  // The header's row includes the gutter, even when the text column stays fixed.
  const headerWidthRef = row.kind === 'header' ? rowRef : undefined
  const session = useActiveSession()
  const profile = useUserProfile()
  const isStreaming = useIsMessageStreaming(message.id)
  const structureSig = useMemo(
    () => messageStructureSignature(message),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [message.parts],
  )

  // Release retained height when a group changes shape or the header replaces
  // its reasoning, including when the last thinking part is deleted.
  let growKey
  switch (row.kind) {
    case 'group':
      growKey = `${messageMeta?.selectedVersion}:${isStreaming}:${structureSig}:${row.promotedToolCallIds?.join() ?? ''}`
      break
    case 'header':
      growKey = `${messageMeta?.selectedVersion}:${row.reasoning?.messageId}:${row.reasoning?.segmentIndex}:${row.reasoning?.groupIndex}`
      break
    default:
      growKey = messageMeta?.selectedVersion
  }

  const canMutate = canMutateMessage(message, messageMeta, session, profile)
  const canEdit = useMemo(
    () => canMutate && isEditableMessage(message),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [message.parts.length, canMutate],
  )

  const content = useMemo(
    () => extractTextFromMessage(message),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [message.parts],
  )

  const messageCtx = useMemo(
    () => ({ id: message.id, canEdit, content }),
    [message.id, canEdit, content],
  )

  const role = messageDisplayRole(message, messageMeta)
  const { look, code } = useMessageAppearance(role, messageMeta)
  const appearanceClass = useScopedAppearance(look)

  const roleClass = role === 'user' ? 'user' : role === 'system' ? 'sys' : 'ai'

  const inner = (
    <MessageContextMenu
      message={message}
      record={messageMeta}
      row={row}
      canMutate={canMutate}
    >
      <div
        ref={headerWidthRef}
        data-slot="message-row"
        data-role={role}
        data-message-id={message.id}
        className={cn(
          'relative z-10 flex min-w-0 flex-col items-start',
          // Grow leftwards into the gutter when there is one
          '-ml-(--message-gutter,0px) w-[calc(100%+var(--message-gutter,0px))] pl-(--message-gutter,0px)',
          // Keep long presses from selecting transcript text on mobile
          isTouchDevice() && 'select-none',
          roleClass,
        )}
      >
        {row.kind === 'footer' ? (
          children
        ) : (
          <GrowOnly growKey={growKey} widthRef={headerWidthRef}>
            {children}
          </GrowOnly>
        )}
      </div>
    </MessageContextMenu>
  )

  return (
    <MessageContext.Provider value={messageCtx}>
      <CodeAppearanceContext.Provider value={code}>
        {appearanceClass ? (
          <div data-slot="appearance-scope" className={appearanceClass}>
            {inner}
          </div>
        ) : (
          inner
        )}
      </CodeAppearanceContext.Provider>
    </MessageContext.Provider>
  )
}

type HeaderRowProps = {
  row: Extract<MessageRow, { kind: 'header' }>
  message: UIMessage
  messageMeta?: MessageRecord
}

function HeaderRow({ row, message, messageMeta }: HeaderRowProps) {
  const highlightRef = useMessageHighlightRef(message.id)
  const role = messageDisplayRole(message, messageMeta)

  const reasoning = useReasoningHeader(message, messageMeta, row.reasoning)

  const sender = {
    name: toDisplayName(
      messageMeta?.senderName,
      role === 'system' ? 'System' : undefined,
    ),
    avatarId: messageMeta?.senderAvatarId,
  }

  return (
    <div
      ref={highlightRef}
      data-slot="message-highlight-target"
      className="w-fit max-w-full min-w-0"
    >
      {reasoning ? (
        <ReasoningHeader
          sender={sender}
          role={role}
          avatarRef={highlightRef}
          openKey={`${row.messageId}:v${messageMeta?.selectedVersion ?? 1}:header-reasoning`}
          part={reasoning.part}
          messageId={message.id}
          segmentIndex={reasoning.segmentIndex}
          groupIndex={reasoning.groupIndex}
        />
      ) : (
        <MessageHeader
          sender={sender}
          role={role}
          avatarRef={highlightRef}
          gutter
        />
      )}
    </div>
  )
}

function useReasoningHeader(
  message: UIMessage,
  messageMeta: MessageRecord | undefined,
  address: Extract<MessageRow, { kind: 'header' }>['reasoning'],
) {
  return useMemo(() => {
    if (!address) return null

    const slice = segmentGroupsFor(message, messageMeta).find(
      (slice) => slice.segmentIndex === address.segmentIndex,
    )
    const group = slice?.groups[address.groupIndex]

    if (group?.type !== 'single' || !isReasoningUIPart(group.part)) {
      return null
    }
    return {
      part: group.part,
      segmentIndex: address.segmentIndex,
      groupIndex: address.groupIndex,
    }
  }, [message, messageMeta, address])
}

type GroupRowProps = {
  row: Extract<MessageRow, { kind: 'group' }>
  message: UIMessage
  messageMeta?: MessageRecord
  partMeta?: PartMetadata
}

function GroupRow({ row, message, messageMeta, partMeta }: GroupRowProps) {
  const attachmentIds = useAttachmentIds(message)
  const slice = segmentGroupsFor(message, messageMeta).find(
    (candidate) => candidate.segmentIndex === row.segmentIndex,
  )
  const group = slice?.groups[row.groupIndex]
  const highlightRef = useMessageHighlightRef(
    highlightTargetForRow(message.id, row),
  )

  if (!group) return null

  const inWorkGroup = Boolean(row.workId && !row.promotedToolCallIds)

  return (
    <div
      data-slot="message-group"
      className={cn(
        'w-full max-w-full wrap-break-word',
        inWorkGroup && 'pl-(--message-group-inset)',
      )}
    >
      <div
        ref={highlightRef}
        data-slot="message-highlight-target"
        className="w-full min-w-0 has-data-full-width:w-full"
      >
        <RenderGroup
          message={message}
          type={messageMeta?.type}
          group={
            row.promotedToolCallIds && group.type === 'tools'
              ? {
                  ...group,
                  parts: group.parts.filter((part) =>
                    row.promotedToolCallIds!.includes(part.toolCallId),
                  ),
                }
              : group
          }
          segmentIndex={row.segmentIndex}
          groupIndex={row.groupIndex}
          inWorkGroup={inWorkGroup}
          version={messageMeta?.selectedVersion ?? 1}
          attachmentIds={attachmentIds}
          partMeta={partMeta}
        />
      </div>
    </div>
  )
}

type FooterRowProps = {
  duration?: number
  message: UIMessage
  messageMeta?: MessageRecord
  isLast: boolean
}

function FooterRow({ duration, message, messageMeta, isLast }: FooterRowProps) {
  const highlightRef = useMessageHighlightRef(message.id)
  const isStreaming = useIsMessageStreaming(message.id)
  const awaitingContinuation = useIsAwaitingVisibleContinuation(message.id)

  const showDuration =
    duration !== undefined && !isStreaming && !awaitingContinuation

  const error = messageMeta?.metadata?.error

  const versionCount = messageMeta?.versionCount ?? 1
  const selectedVersion = messageMeta?.selectedVersion ?? 1
  const showSwitcher = versionCount > 1

  const showChanges = messageMeta?.hasChanges && !isStreaming

  if (!error && !showDuration && !showSwitcher && !showChanges) {
    return null
  }

  return (
    <div
      ref={highlightRef}
      data-slow="message-footer"
      className={cn(
        'flex w-full flex-col empty:hidden',
        !isLast && 'pb-4 in-data-footer-before-reset:pb-0',
      )}
    >
      {error && (
        <div className="px-4 pt-3">
          <ErrorBlock messageId={message.id} error={error} />
        </div>
      )}
      {showChanges && (
        <ChangesSummary
          key={`${message.id}:${selectedVersion}`}
          messageId={message.id}
          version={selectedVersion}
        />
      )}
      {(showSwitcher || showDuration) && (
        <div className="flex items-center gap-3 pt-4">
          {showSwitcher && (
            <MessageVersionSwitcher
              messageId={message.id}
              selectedVersion={selectedVersion}
              versionCount={versionCount}
              disabled={isStreaming}
            />
          )}
          {showDuration && (
            <span className="text-muted-foreground/80 text-sm tabular-nums">
              Worked for {formatDuration(duration)}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
