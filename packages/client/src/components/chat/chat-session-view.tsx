import { useElementHeight, useKeyboardViewport } from '@/hooks'
import {
  useActiveSession,
  useAgentPrompts,
  useAvatarSize,
  useChatWidth,
  useIsAdmin,
  useSendCooldownUntil,
  useSessionApprovalMode,
  useSessionMode,
  useSettings,
  useStreamAwaitingAnswer,
  useStreamAwaitingApproval,
  useStreamRawStatus,
  useTypingIndicator,
  useUnseenTailActivity,
} from '@/hooks/chat'
import type { useChatStatus, useWorkspaceFileIndex } from '@/hooks/chat'
import { useApprovalReview } from '@/hooks/chat/approval-review'
import { useComposerReveal } from '@/hooks/chat/composer-reveal'
import { useComposerReply } from '@/hooks/chat/reply-target'
import { useRestoreShellFocus } from '@/hooks/chat/shell-focus'
import { useHasElapsed } from '@/hooks/expiry'
import { useAtBottomSticky } from '@/hooks/scroll'
import type { PendingMessage } from '@/lib/chat'
import { ChatWarning } from '@/lib/chat/errors'
import {
  avatarVars,
  columnMargin,
  columnWidth,
} from '@/lib/chat/message-geometry'
import { isOngoingStream } from '@/lib/chat/stream'
import { cn } from '@/lib/utils'
import { api } from '@cv/convex/_generated/api'
import { DEFAULT_SETTINGS } from '@cv/convex/model/defaults'
import { parseShellCommand } from '@cv/core/shell/command'
import { useQuery } from 'convex/react'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'

import { ChatAlert } from './chat-alert'
import { SlowModeLabel } from './chat-countdowns'
import { ChatDock } from './chat-dock'
import { ChatLayout } from './chat-layout'
import { ChatPrompts } from './chat-prompts'
import { ChatDockHeader, ChatToolbar } from './chat-toolbar'
import type { ChatToolbarProps } from './chat-toolbar'
import { ActivityIndicator } from './composer/activity-indicator'
import { ChatComposer } from './composer/chat-composer'
import type { ComposerHandle } from './composer/chat-composer'
import { ComposerReply } from './composer/composer-reply'
import { ComposerToolbar } from './composer/composer-toolbar'
import { useMessageEdit } from './messages/editor'
import { MessageHighlightProvider } from './messages/message-highlight-context'
import { MessageList, type MessageListHandle } from './messages/message-list'
import { MessageSeekProvider } from './messages/message-seek-context'
import { ShellSeekFromUrl } from './messages/shell-seek'
import { HistorySearchDialog, useChatSearch, useChatSearchHost } from './search'
import type { AgentItem } from './sessions/agent-combobox'
import { ChatShortcutsProvider } from './shortcuts'
import { SubagentBanner } from './subagents/subagent-banner'
import { DockWidgets } from './widgets/dock-widgets'
import { AnswerPicker } from './workspace/answer-picker'
import { ReviewApprovalButton } from './workspace/review-approval-button'
import { ToolApprovalPicker } from './workspace/tool-approval-picker'

const DOCK_HIDE_DISTANCE = 160

type ChatSessionViewProps = {
  dockWidth: string
  topPadding: number
  status: ReturnType<typeof useChatStatus>
  error: Error | null
  onSubmit: (msg: PendingMessage) => Promise<string>
  onStop: () => void
  onRunCommand: (
    name: string,
    argument: string,
    silent: boolean,
  ) => Promise<void>
  onContinueAgent: () => void
  hasActiveAgent: boolean
  activeAgentName?: string
  activeAgentDisplay?: AgentItem
  onInitialPositionSettled?: () => void
  focusComposerOnMount?: boolean
  onDismissError: () => void
  fileIndex: ReturnType<typeof useWorkspaceFileIndex>
}

export function ChatSessionView({
  dockWidth,
  topPadding,
  status,
  error,
  onSubmit,
  onStop,
  onRunCommand,
  onContinueAgent,
  hasActiveAgent,
  activeAgentName,
  activeAgentDisplay,
  onInitialPositionSettled,
  focusComposerOnMount,
  onDismissError,
  fileIndex,
}: ChatSessionViewProps) {
  const session = useActiveSession()
  // Sub-agent sessions expose approvals and navigation instead of a composer.
  const subagentParent = session?.parent

  // Composer
  const { typingUsers, notify, clearTyping, stopTyping } = useTypingIndicator(session?._id) // prettier-ignore
  const passiveSend = session?.settings?.passiveSend ?? false
  const isStopping = useStreamRawStatus() === 'stopping'
  const cooldownUntil = useSendCooldownUntil()
  const cooldownElapsed = useHasElapsed(cooldownUntil)
  const sendDisabled = !!cooldownUntil && !cooldownElapsed
  const [isPinned, setPinned] = useState(false)
  const [hasContent, setHasContent] = useState(false)
  const [draftReady, setDraftReady] = useState(false)

  // Prompt evaluation
  const evaluationStartedAt = useQuery(
    api.promptEvaluations.active,
    session ? { sessionId: session._id } : 'skip',
  )
  const evaluating = evaluationStartedAt != null
  const evaluationWarningElapsed = useHasElapsed(
    evaluating ? evaluationStartedAt + 5000 : undefined,
  )
  const slowEvaluation = evaluating && evaluationWarningElapsed

  // Message editing
  const editCtx = useMessageEdit()
  const editingMessageId = editCtx?.editingMessageId ?? null
  const completedEditRevision = editCtx?.completedEditRevision ?? 0
  const isEditing = !!editingMessageId

  // Workspace
  const workspaceAvailable = Boolean(session?.workspace)
  const awaitingApproval = useStreamAwaitingApproval()
  const awaitingAnswer = useStreamAwaitingAnswer()
  const canApproveTools = useIsAdmin()
  const { mode, setMode } = useSessionMode()
  const approval = useSessionApprovalMode()
  const canUseWorkspace = canApproveTools && workspaceAvailable

  // Search
  const { open: openSearch } = useChatSearch()
  const { isOpen: searchOpen, close: closeSearch } = useChatSearchHost()

  // Layout
  const [alertHeight, setAlertHeight] = useState(0)
  const [widgetsRef, widgetsHeight] = useElementHeight<HTMLDivElement>()
  const keyboardViewport = useKeyboardViewport()
  const keyboardInset = keyboardViewport.bottomInset
  const chatWidth = useChatWidth()
  const avatarSize = useAvatarSize()
  const showBackgrounds =
    useSettings()?.messageBackgrounds ?? DEFAULT_SETTINGS.messageBackgrounds
  const messageStyle = {
    width: columnWidth(chatWidth, '%'),
    '--message-column-margin': columnMargin(chatWidth),
    ...avatarVars(avatarSize),
  } as React.CSSProperties

  const hasPrompts = useAgentPrompts().messages.length > 0

  const messageListRef = useRef<MessageListHandle>(null)
  const composerRef = useRef<ComposerHandle>(null)
  const [initialPositionSettled, setInitialPositionSettled] = useState(false)

  const {
    isAtBottom,
    onScroll: onMessageListScroll,
    release: releaseSticky,
  } = useAtBottomSticky(
    useCallback(() => {
      messageListRef.current?.lockScroll()
    }, []),
    {
      unstickDistance: DOCK_HIDE_DISTANCE,
      suspended: !initialPositionSettled,
      bottomInset: keyboardInset,
    },
  )

  useLayoutEffect(() => {
    if (initialPositionSettled) onMessageListScroll()
  }, [initialPositionSettled, onMessageListScroll])

  useEffect(() => {
    if (initialPositionSettled) onInitialPositionSettled?.()
  }, [initialPositionSettled, onInitialPositionSettled])

  const handleInitialPositionSettled = useCallback(
    () => setInitialPositionSettled(true),
    [],
  )

  const {
    visible: keepComposerVisible,
    begin: holdComposerForReveal,
    clear: clearComposerReveal,
    keepVisible: revealComposerForFocus,
  } = useComposerReveal(session?._id, isAtBottom)

  const reply = useComposerReply({
    sessionId: session?._id,
    composerRef,
    onSubmit,
  })
  const hasReply = reply.target !== undefined

  const unseenActivity = useUnseenTailActivity(isAtBottom)
  const hasActivity = isOngoingStream(status) || unseenActivity
  const agentWaiting = awaitingApproval || awaitingAnswer
  const composerDocked =
    !isEditing && (isPinned || isAtBottom || hasContent || hasReply)

  const review = useApprovalReview({
    awaitingApproval,
    awaitingAnswer,
    canApproveTools,
    composerDocked,
    composerIdle: draftReady && !hasContent,
    reviewBlocked: isEditing || searchOpen,
  })

  const showDock =
    composerDocked ||
    review.showApproval ||
    (!isEditing && (keepComposerVisible || evaluating))
  const showInteractionPicker = review.showApproval || awaitingAnswer
  const showToolbar = !isAtBottom || isEditing
  const showReviewAction = review.showReviewButton && !review.fullscreen && !isEditing // prettier-ignore
  const reviewInDock = showReviewAction && showDock && !showInteractionPicker

  const restoreComposerFocus = useRestoreShellFocus({
    composerRef,
    available:
      !subagentParent && !isEditing && !searchOpen && !showInteractionPicker,
    dockVisible: showDock,
    revealComposer: revealComposerForFocus,
  })

  function openReview() {
    if (!showDock) messageListRef.current?.followToBottom()
    review.review()
  }

  function hideReview() {
    review.hide()
    requestAnimationFrame(() =>
      composerRef.current?.focus({ preventScroll: true }),
    )
  }

  const pendingFocusRef = useRef(false)
  const pinToBottom = useCallback(() => {
    messageListRef.current?.followToBottom()
    if (showDock) composerRef.current?.focus({ preventScroll: true })
    else pendingFocusRef.current = true
  }, [showDock])

  useEffect(() => {
    if (showDock && pendingFocusRef.current) {
      pendingFocusRef.current = false
      composerRef.current?.focus({ preventScroll: true })
    }
  }, [showDock])

  const handledEditRevisionRef = useRef(completedEditRevision)
  // Refocus composer after editing a message
  useEffect(() => {
    if (completedEditRevision === handledEditRevisionRef.current) return
    handledEditRevisionRef.current = completedEditRevision
    if (!showDock || showInteractionPicker) return

    const frame = requestAnimationFrame(() =>
      composerRef.current?.focus({ preventScroll: true }),
    )
    return () => cancelAnimationFrame(frame)
  }, [completedEditRevision, showDock, showInteractionPicker])

  const submitMessage = reply.submit

  const handleSubmit = useCallback(
    async (msg: PendingMessage) => {
      const messageId = await submitMessage(msg)
      clearTyping()
      const isUserMessage = !msg.role || msg.role === 'user'
      const isShellCommand =
        isUserMessage && parseShellCommand(msg.content.trim()) !== null
      messageListRef.current?.revealSentMessage(messageId, {
        intoView: isShellCommand,
      })
    },
    [submitMessage, clearTyping],
  )

  const handleContentChange = useCallback(
    (has: boolean, ready: boolean) => {
      setHasContent(has)
      setDraftReady(ready)
      // Emptying the composer cancels a pending heartbeat or clears the
      // indicator after a short grace window
      if (!has) stopTyping()
    },
    [stopTyping],
  )

  const handleAbort = useCallback(() => {
    onStop()
    if (showInteractionPicker) return
    if (showDock) {
      requestAnimationFrame(() =>
        composerRef.current?.focus({ preventScroll: true }),
      )
    } else {
      pendingFocusRef.current = true
    }
  }, [onStop, showDock, showInteractionPicker])

  const toolbar: ChatToolbarProps = {
    showScroll: !isAtBottom,
    activity: hasActivity,
    onScrollToBottom: pinToBottom,
    pinnable: !isEditing,
    pinned: isPinned,
    onPinChange: setPinned,
    editing: isEditing,
    onEditSave: editCtx?.onSave,
    onEditCancel: editCtx?.onCancel,
  }

  const reviewAction = showReviewAction && (
    <ReviewApprovalButton
      compact
      onClick={openReview}
      className="pointer-events-auto"
    />
  )

  return (
    <ChatShortcutsProvider
      messageListRef={messageListRef}
      onPinToBottom={pinToBottom}
      onAbort={handleAbort}
      onOpenSearch={openSearch}
    >
      <MessageSeekProvider messageListRef={messageListRef}>
        <MessageHighlightProvider>
          <ShellSeekFromUrl />
          <ChatLayout
            scrollbar
            onScrollbarNavigate={clearComposerReveal}
            bottomInset={keyboardInset}
            mainContent={(bottomPadding, dockHeight) => (
              <MessageList
                ref={messageListRef}
                className="mx-auto w-full flex-1"
                innerStyle={messageStyle}
                showBackgrounds={showBackgrounds}
                topPadding={topPadding}
                bottomPadding={bottomPadding}
                // The approval and composer reserve different amounts of space.
                extraBottomInset={review.request ? dockHeight : 0}
                header={hasPrompts && <ChatPrompts className="h-fit" />}
                isAtBottom={isAtBottom}
                onScrollChange={onMessageListScroll}
                onIntoViewSettle={releaseSticky}
                onInitialPositionSettled={handleInitialPositionSettled}
                onTranscriptNavigate={clearComposerReveal}
                holdComposerForReveal={holdComposerForReveal}
                restoreComposerFocus={restoreComposerFocus}
                shellFocusBlocked={
                  isEditing || searchOpen || showInteractionPicker || hasContent
                }
              />
            )}
            dockHeader={(stackHeight, footerHeight) =>
              !reviewInDock && (
                <ChatDockHeader
                  dockWidth={dockWidth}
                  docked={showDock}
                  stackHeight={stackHeight}
                  footerHeight={footerHeight}
                  widgetsHeight={widgetsHeight}
                  alertHeight={alertHeight}
                  toolbar={showToolbar ? toolbar : undefined}
                  review={!showDock && reviewAction}
                />
              )
            }
            dockFooter={
              <div className="flex h-4 w-full min-w-0 items-center">
                <ActivityIndicator
                  className="pl-2"
                  names={typingUsers.map((user) => user.name)}
                  agent={
                    isOngoingStream(status)
                      ? {
                          name: activeAgentName ?? 'Agent',
                          state: agentWaiting ? 'waiting' : 'working',
                        }
                      : undefined
                  }
                />
                <SlowModeLabel className="ml-auto shrink-0" />
              </div>
            }
            dockFooterWidth={dockWidth}
            dock={
              <ChatDock
                width={dockWidth}
                hidden={!subagentParent && (isEditing || !showDock)}
                inert={!subagentParent && isEditing}
                onAlertHeightChange={setAlertHeight}
                alert={
                  <ChatAlert
                    error={
                      slowEvaluation
                        ? new ChatWarning(
                            'Prompt evaluation is taking too long...',
                            'prompt-evaluation',
                          )
                        : error
                    }
                    dismissible={!slowEvaluation}
                    onDismiss={onDismissError}
                    className="mb-1.5 w-[calc(100%-var(--spacing)*8)]"
                  />
                }
              >
                {subagentParent && (
                  <SubagentBanner
                    parent={subagentParent}
                    title={session?.title}
                    status={status}
                    onStop={onStop}
                    onScrollToBottom={() =>
                      messageListRef.current?.followToBottom()
                    }
                  />
                )}
                {review.showApproval && review.request && (
                  <ToolApprovalPicker
                    key={review.request.key}
                    request={review.request}
                    childApproval={review.childApproval}
                    focusOnOpen={review.focusOnOpen}
                    restoreFocusRef={composerRef}
                    onAbort={
                      review.childApproval ? review.abortChild : handleAbort
                    }
                    onHide={subagentParent ? undefined : hideReview}
                    className="pointer-events-auto w-full"
                  />
                )}
                {!subagentParent && awaitingAnswer && (
                  <AnswerPicker
                    restoreFocusRef={composerRef}
                    onAbort={handleAbort}
                    viewportHeight={keyboardViewport.height}
                    className="pointer-events-auto w-full"
                  />
                )}
                {!subagentParent && (
                  <>
                    <DockWidgets
                      ref={widgetsRef}
                      className={cn(showInteractionPicker && 'hidden')}
                      actions={
                        reviewInDock && (
                          <>
                            {reviewAction}
                            {showToolbar && (
                              <ChatToolbar
                                {...toolbar}
                                className="pointer-events-auto shrink-0"
                              />
                            )}
                          </>
                        )
                      }
                    />
                    <ChatComposer
                      onSubmit={handleSubmit}
                      onTyping={notify}
                      onStop={onStop}
                      stopDisabled={isStopping}
                      evaluatingPrompt={evaluating}
                      onRunCommand={onRunCommand}
                      onContinueAgent={onContinueAgent}
                      canContinueAgent={hasActiveAgent && status === 'ready'}
                      commandAvailability={{
                        hasActiveSession: true,
                        hasActiveAgent,
                      }}
                      activeAgentName={activeAgentName}
                      startContent={
                        <ComposerToolbar
                          fallbackAgent={activeAgentDisplay}
                          mode={{
                            value: mode,
                            workspaceAvailable,
                            set: setMode,
                          }}
                          approval={{
                            value: approval.mode,
                            available: canApproveTools,
                            toggle: approval.toggleMode,
                          }}
                        />
                      }
                      mode={{
                        value: mode,
                        workspaceAvailable,
                        set: setMode,
                      }}
                      onContentChange={handleContentChange}
                      notice={
                        <>
                          {review.showReviewButton && review.fullscreen && (
                            <ReviewApprovalButton
                              onClick={openReview}
                              className="order-first w-full px-4 pt-1"
                            />
                          )}
                          {reply.target && (
                            <ComposerReply
                              target={reply.target}
                              onCancel={reply.cancel}
                            />
                          )}
                        </>
                      }
                      status={status}
                      inputRef={composerRef}
                      focusOnMount={focusComposerOnMount ?? false}
                      fileIndex={fileIndex}
                      passiveSend={passiveSend}
                      sendDisabled={sendDisabled}
                      fileDropDisabled={isEditing || showInteractionPicker}
                      shellAvailable={canUseWorkspace}
                      draftKey={session?._id}
                      className={cn(
                        'w-full',
                        showInteractionPicker && 'hidden',
                      )}
                      inert={!showDock || showInteractionPicker}
                    />
                  </>
                )}
              </ChatDock>
            }
          />
          <HistorySearchDialog
            open={searchOpen}
            onClose={closeSearch}
            messageListRef={messageListRef}
          />
        </MessageHighlightProvider>
      </MessageSeekProvider>
    </ChatShortcutsProvider>
  )
}
