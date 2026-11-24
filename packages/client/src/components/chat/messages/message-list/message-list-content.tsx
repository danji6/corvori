import { RippleButton, WavyProgressCircle } from '@/components/ui'
import { useVirtualizedLayout } from '@/hooks/chat/message-list/virtualized-layout'
import { messageBackgroundGroup } from '@/lib/chat/message-backgrounds'
import { isNoteBoundaryRow } from '@/lib/chat/note-rows'
import { noteExpansion } from '@/lib/chat/note-state'
import type { RowTransition } from '@/lib/chat/row-expansion-state'
import type { MessageRow } from '@/lib/chat/rows'
import { isTranscriptDividerRow } from '@/lib/chat/sender-groups'
import { workExpansion } from '@/lib/chat/work-state'
import { cn } from '@/lib/utils'
import { AnimatePresence, motion } from 'motion/react'
import {
  type CSSProperties,
  type ReactElement,
  type ReactNode,
  type RefObject,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { CustomItemComponentProps, WindowVirtualizerHandle } from 'virtua'

import { EmptyMessage } from '../../empty-message'
import {
  VirtualizedRowTransition,
  useRowTransitions,
} from '../virtualized-row-transition'
import { getRowSpacing, getWorkDetailTrailingSpacing } from './row-spacing'
import { TranscriptWindow } from './transcript-window'

const CONTENT_FADE_TRANSITION = { duration: 0.18, ease: 'easeOut' } as const

const VirtualizedRowsContext = createContext<{
  rows: readonly MessageRow[]
  showBackgrounds: boolean
}>({ rows: [], showBackgrounds: false })

const RowTransitionsContext = createContext<ReadonlyMap<string, RowTransition>>(
  new Map(),
)

export type OverlayInset = { top: number; bottom: number }

type MessageListContentProps = {
  /** Whether the list has finished positioning and may fade into view. */
  revealed: boolean
  isEmpty: boolean
  showLoadingIndicator: boolean
  /** Viewport insets the loading overlay has to stay clear of. */
  overlayInset: OverlayInset
  emptyStyle?: CSSProperties
  messages: MessageRowsProps
}

export function MessageListContent({
  revealed,
  isEmpty,
  showLoadingIndicator,
  overlayInset,
  emptyStyle,
  messages,
}: MessageListContentProps) {
  if (isEmpty) {
    return (
      <ContentFade className="flex flex-1 flex-col justify-center">
        <EmptyMessage style={emptyStyle} />
      </ContentFade>
    )
  }

  return (
    <>
      <AnimatePresence>
        {!revealed && (
          <LoadingOverlay
            key="loading"
            showIndicator={showLoadingIndicator}
            inset={overlayInset}
          />
        )}
      </AnimatePresence>
      <motion.div
        // Query container for the avatar gutter
        className="@container w-full"
        initial={{ opacity: 0 }}
        animate={{ opacity: revealed ? 1 : 0 }}
        transition={CONTENT_FADE_TRANSITION}
      >
        <MessageRows {...messages} />
      </motion.div>
    </>
  )
}

/** Enables frame-dependent cross-fade animation that would otherwise be skipped. */
function ContentFade({
  className,
  children,
}: {
  className: string
  children: ReactNode
}) {
  const [enter, setEnter] = useState(false)
  useEffect(() => {
    const id = requestAnimationFrame(() => setEnter(true))
    return () => cancelAnimationFrame(id)
  }, [])

  return (
    <motion.div
      className={className}
      initial={{ opacity: 0 }}
      animate={{ opacity: enter ? 1 : 0 }}
      exit={{ opacity: 0 }}
      transition={CONTENT_FADE_TRANSITION}
    >
      {children}
    </motion.div>
  )
}

type LoadingOverlayProps = {
  showIndicator: boolean
  inset: OverlayInset
}

/**
 * Loading overlay shown while the list positions itself, centered in the band
 * of viewport the list is visible through.
 */
function LoadingOverlay({ showIndicator, inset }: LoadingOverlayProps) {
  return (
    <motion.div
      className="pointer-events-none sticky z-10 h-0"
      style={{ top: inset.top }}
      initial={{ opacity: 1 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={CONTENT_FADE_TRANSITION}
    >
      <div
        className="absolute inset-x-0 flex items-center justify-center"
        style={{ height: `calc(100dvh - ${inset.top + inset.bottom}px)` }}
      >
        <AnimatePresence>
          {showIndicator && (
            <motion.div
              key="loading-indicator"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={CONTENT_FADE_TRANSITION}
            >
              <WavyProgressCircle size={64} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  )
}

type MessageRowsProps = {
  rows: readonly MessageRow[]
  showBackgrounds?: boolean
  hasHeaderContainer: boolean
  innerStyle?: CSSProperties
  topPadding?: number
  topPaddingStyle: CSSProperties
  header?: ReactNode
  hasMore: boolean
  isLoadingOlder?: boolean
  hasNewer: boolean
  /** Whether virtua should shift to preserve position. */
  shiftItems: boolean
  onLoadMore: () => void
  onLoadNewer: () => void
  renderRow: (row: MessageRow) => ReactElement
  virtuaRef: RefObject<WindowVirtualizerHandle | null>
}

function MessageRows({
  rows,
  showBackgrounds = false,
  hasHeaderContainer,
  innerStyle,
  topPadding,
  topPaddingStyle,
  header,
  hasMore,
  isLoadingOlder,
  hasNewer,
  shiftItems,
  onLoadMore,
  onLoadNewer,
  renderRow,
  virtuaRef,
}: MessageRowsProps) {
  const root = useRef<HTMLDivElement>(null)
  const transitionLayout = { rows, root, virtualizer: virtuaRef }
  const workTransitions = useRowTransitions(workExpansion, transitionLayout)
  const noteTransitions = useRowTransitions(noteExpansion, transitionLayout)

  const transitions = useMemo(
    () => new Map([...workTransitions, ...noteTransitions]),
    [workTransitions, noteTransitions],
  )

  const rowOptions = useMemo(
    () => ({ rows, showBackgrounds }),
    [rows, showBackgrounds],
  )
  const layout = useVirtualizedLayout({
    rows,
    transitions,
    virtualizer: virtuaRef,
  })

  return (
    <>
      {hasHeaderContainer && (
        <div
          className="mx-auto w-full pb-8"
          style={{
            ...innerStyle,
            ...(topPadding && {
              paddingTop: `calc(var(--spacing)*${topPadding})`,
            }),
          }}
        >
          {!hasMore && header}
          {hasMore && (
            <LoadWindowButton
              onClick={onLoadMore}
              label="Load older messages"
              loading={isLoadingOlder}
            />
          )}
        </div>
      )}
      <div
        ref={root}
        // The minimum reserves row height. Top padding is additional.
        className="chat-transcript-column mx-auto box-content motion-safe:transition-[--message-gutter]"
        data-message-backgrounds={showBackgrounds ? '' : undefined}
        style={
          hasHeaderContainer
            ? { ...innerStyle, minHeight: layout.minHeight }
            : { ...innerStyle, ...topPaddingStyle, minHeight: layout.minHeight }
        }
      >
        <VirtualizedRowsContext value={rowOptions}>
          <RowTransitionsContext value={transitions}>
            <TranscriptWindow
              ref={virtuaRef}
              rows={rows}
              showBackgrounds={showBackgrounds}
              transitions={transitions}
              item={VirtualizedItem}
              shift={shiftItems || layout.shift}
              onResize={layout.onResize}
              renderRow={renderRow}
            />
          </RowTransitionsContext>
        </VirtualizedRowsContext>
      </div>
      {hasNewer && (
        <div className="mx-auto w-full pt-8" style={innerStyle}>
          <LoadWindowButton onClick={onLoadNewer} label="Load newer messages" />
        </div>
      )}
    </>
  )
}

function LoadWindowButton({
  onClick,
  label,
  loading = false,
}: {
  onClick: () => void
  label: string
  loading?: boolean
}) {
  return (
    <div className="flex justify-center">
      <RippleButton
        variant="input"
        onClick={onClick}
        disabled={loading}
        aria-busy={loading}
        data-load-older={label === 'Load older messages' ? '' : undefined}
      >
        {loading && <WavyProgressCircle size={16} />}
        {label}
      </RippleButton>
    </div>
  )
}

function VirtualizedItem({
  style,
  index,
  children,
  ref,
}: CustomItemComponentProps) {
  const { rows, showBackgrounds } = useContext(VirtualizedRowsContext)
  const transitions = useContext(RowTransitionsContext)
  const row = rows[index]
  const previousRow = rows[index - 1]
  const nextRow = rows[index + 1]
  const precedesNote = isNoteBoundaryRow(nextRow)
  const precedesDivider = isTranscriptDividerRow(nextRow)
  const spacing = getRowSpacing(row, previousRow)
  const workDetailTrailingSpacing = getWorkDetailTrailingSpacing(row, nextRow)

  const backgroundGroup = showBackgrounds
    ? messageBackgroundGroup(row)
    : undefined
  const startsBackground =
    backgroundGroup && messageBackgroundGroup(previousRow) !== backgroundGroup
  const endsBackground =
    backgroundGroup && messageBackgroundGroup(nextRow) !== backgroundGroup

  const content = (
    <>
      {spacing && <div aria-hidden style={{ height: spacing }} />}
      {startsBackground && (
        <div
          aria-hidden
          className="h-(--message-background-padding-block-start)"
        />
      )}
      {children}
      {endsBackground && (
        <div
          aria-hidden
          className="h-(--message-background-padding-block-end)"
        />
      )}
    </>
  )

  // The gutter avatar overhangs its header row into the band of the row below.
  // Without this, Virtua would make the avatar unclickable because it uses
  // `contain: layout` on every item.
  const overhang = row?.kind === 'header' ? { ...style, zIndex: 1 } : style

  return (
    <div
      ref={ref}
      data-slot="virtualized-item"
      data-row-kind={row?.kind}
      data-message-id={row?.messageId}
      data-sender-group-id={row?.senderGroupId ?? row?.messageId}
      data-row-key={row?.key}
      data-note-group-id={row?.kind === 'hidden' ? row.noteGroupId : undefined}
      data-work-id={row?.kind === 'group' ? row.workId : undefined}
      data-segment-index={row?.kind === 'group' ? row.segmentIndex : undefined}
      style={overhang}
    >
      {row?.kind === 'group' && row.workId ? (
        <VirtualizedRowTransition
          state={
            row.promotedToolCallIds
              ? undefined
              : transitions.get(row.workId)?.phase
          }
        >
          {row.promotedToolCallIds ? (
            content
          ) : (
            <div
              className={cn(
                'chat-work-row border-border/60 border-l',
                precedesNote && 'chat-work-before-note',
              )}
            >
              {content}
            </div>
          )}
          {workDetailTrailingSpacing && (
            <div aria-hidden style={{ height: workDetailTrailingSpacing }} />
          )}
        </VirtualizedRowTransition>
      ) : row?.kind === 'hidden' && row.noteGroupId ? (
        <VirtualizedRowTransition
          state={transitions.get(row.noteGroupId)?.phase}
        >
          <div className="border-border/60 border-l pl-(--message-group-inset)">
            {content}
          </div>
          {nextRow && !precedesNote && !precedesDivider && (
            <div aria-hidden className="h-(--message-compact-block-gap)" />
          )}
        </VirtualizedRowTransition>
      ) : (
        content
      )}
    </div>
  )
}
