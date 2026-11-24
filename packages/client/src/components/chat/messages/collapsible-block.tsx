import { Accordion } from '@/components/ui/accordion'
import { Button } from '@/components/ui/button'
import { Collapsible, useCollapsible } from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'

import { useGrowOnly } from './grow-only'
import {
  useMessageList,
  usePendingMessageLayout,
} from './message-list/message-list-context'

export type CollapsibleBlockProps = React.ComponentPropsWithoutRef<'div'> & {
  label: React.ReactNode
  leadingIcon?: React.ReactNode
  actions?: React.ReactNode
  canExpand?: boolean
  /** When false, the body is always shown and the header is non-interactive. */
  collapsible?: boolean
  /** Animate the label with a shimmer. */
  shimmer?: boolean
  /** The bordered surface expands its padding. Inset rows start indented. */
  surface?: boolean | 'inset' | 'inset-row'
  /** Compact header height and no outer margin, for stacking inside a group. */
  dense?: boolean
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  fullWidth?: boolean
  footer?: React.ReactNode
  headerClassName?: string
  triggerClassName?: string
  bodyClassName?: string
  labelClassName?: string
  /** Make the chevron icon absolutely positioned on the right. */
  floatingChevron?: boolean
  /** Replaces the expand toggle as the header click action (hides the chevron). */
  onLabelClick?: () => void
}

export function CollapsibleBlock({
  label,
  leadingIcon,
  actions,
  canExpand = true,
  collapsible = true,
  shimmer = false,
  surface = false,
  dense = false,
  defaultOpen = false,
  open,
  onOpenChange,
  fullWidth = false,
  footer,
  className,
  headerClassName,
  triggerClassName,
  bodyClassName,
  labelClassName,
  floatingChevron,
  onLabelClick,
  children,
  ...rest
}: CollapsibleBlockProps) {
  const contentId = useId()
  const messageList = useMessageList()
  const releaseHeight = useGrowOnly()?.release

  // Re-measure retained row heights when the header density changes.
  useLayoutEffect(() => {
    releaseHeight?.()
  }, [dense, releaseHeight])

  const insetRow = surface === 'inset-row' || surface === true
  const insetSurface = surface === 'inset' || insetRow
  const rowMinH = dense ? undefined : 'min-h-9'
  const body = children && (
    <div
      className={cn(
        collapsible ? 'chat-block-body' : 'chat-block-list',
        insetSurface && 'chat-block-body-inset',
        bodyClassName,
      )}
    >
      {children}
    </div>
  )

  const shellClassName = cn(
    'group overflow-x-auto rounded-none border border-transparent motion-safe:transition-[background-color,border-color,border-radius,box-shadow]',
    fullWidth ? 'w-full' : 'w-fit max-w-full',
    surface &&
      'data-[open=true]:bg-m3-surface-container-low data-[open=true]:border-border rounded-2xl',
    insetSurface &&
      'chat-block-inset data-[open=true]:rounded-(--work-surface-radius) motion-safe:transition-[--work-surface-expansion,background-color,border-color,border-radius,box-shadow] motion-safe:duration-200 motion-safe:ease-in-out',
    insetSurface &&
      surface !== true &&
      'data-[open=true]:inset-ring-border rounded-none border-0 data-[open=true]:inset-ring',
    insetRow && 'chat-block-inset-row',
    className,
  )

  if (!collapsible) {
    return (
      <>
        <div
          data-open="true"
          data-full-width={fullWidth ? '' : undefined}
          className={shellClassName}
          {...rest}
        >
          <div
            className={cn(
              'flex items-center px-(--work-body-padding)',
              rowMinH,
              insetSurface && 'p-0',
              headerClassName,
            )}
          >
            <Header
              leadingIcon={leadingIcon}
              label={label}
              shimmer={shimmer}
              dense={dense}
              labelClassName={labelClassName}
            />
            {actions}
          </div>
          {body}
        </div>
        {footer}
      </>
    )
  }

  return (
    <>
      <div>
        <Collapsible
          defaultOpen={defaultOpen}
          open={open}
          onOpenChange={(next) => {
            messageList?.onLayoutChange()
            onOpenChange?.(next)
          }}
          data-full-width={fullWidth ? '' : undefined}
          className={shellClassName}
          {...rest}
        >
          <div
            className={cn(
              'chat-header-focus flex items-center rounded-3xl',
              !insetSurface && 'px-(--work-body-padding)',
              rowMinH,
              headerClassName,
            )}
          >
            <Trigger
              className={cn(
                insetSurface && 'py-0',
                insetRow && 'py-(--work-header-padding-y)',
                triggerClassName,
              )}
              contentId={contentId}
              leadingIcon={leadingIcon}
              label={label}
              canExpand={canExpand}
              shimmer={shimmer}
              dense={dense}
              labelClassName={labelClassName}
              floatingChevron={floatingChevron}
              onLabelClick={onLabelClick}
            />
            {actions}
          </div>
          <Content id={contentId}>{body}</Content>
        </Collapsible>
      </div>
      {footer}
    </>
  )
}

type LabelProps = {
  leadingIcon?: React.ReactNode
  label: React.ReactNode
  shimmer?: boolean
  className?: string
}

function Label({ leadingIcon, label, shimmer, className }: LabelProps) {
  return (
    <>
      {leadingIcon}
      <span
        className={cn(
          'min-w-0 text-xs wrap-anywhere',
          shimmer ? 'text-shimmer' : 'text-muted-foreground',
          className,
        )}
      >
        {label}
      </span>
    </>
  )
}

function Header({
  leadingIcon,
  label,
  shimmer,
  dense,
  labelClassName,
}: {
  leadingIcon?: React.ReactNode
  label: React.ReactNode
  shimmer?: boolean
  dense?: boolean
  labelClassName?: string
}) {
  return (
    <div
      className={cn(
        'flex min-w-0 grow items-center gap-2',
        dense ? 'chat-work-header' : 'min-h-9 py-2',
      )}
    >
      <Label
        leadingIcon={leadingIcon}
        label={label}
        shimmer={shimmer}
        className={labelClassName}
      />
    </div>
  )
}

type TriggerProps = {
  className?: string
  contentId: string
  leadingIcon?: React.ReactNode
  label: React.ReactNode
  canExpand: boolean
  shimmer?: boolean
  dense?: boolean
  labelClassName?: string
  floatingChevron?: boolean
  onLabelClick?: () => void
}

function Trigger({
  className,
  contentId,
  leadingIcon,
  label,
  canExpand,
  shimmer,
  dense,
  labelClassName,
  floatingChevron,
  onLabelClick,
}: TriggerProps) {
  const { isOpen, toggle } = useCollapsible()
  const showChevron = canExpand && !onLabelClick

  return (
    <Button
      variant="plain"
      size={null}
      data-block-trigger=""
      aria-expanded={showChevron ? isOpen : undefined}
      aria-controls={showChevron ? contentId : undefined}
      onClick={onLabelClick ?? (canExpand ? toggle : undefined)}
      className={cn(
        'flex min-w-0 shrink grow items-center justify-start gap-2 rounded-none text-left whitespace-normal focus-visible:ring-0',
        dense ? 'chat-work-header' : 'min-h-9 py-2',
        floatingChevron && 'relative',
        className,
      )}
    >
      <Label
        leadingIcon={leadingIcon}
        label={label}
        shimmer={shimmer}
        className={labelClassName}
      />
      {showChevron && (
        <Accordion.Icon
          aria-hidden
          isExpanded={isOpen}
          className={cn(
            'chat-collapsible-chevron text-muted-foreground shrink-0',
            floatingChevron && 'absolute right-1',
          )}
        />
      )}
    </Button>
  )
}

function Content({ id, children }: { id: string; children?: React.ReactNode }) {
  const { isOpen } = useCollapsible()
  const contentRef = useRef<HTMLDivElement>(null)
  const [present, setPresent] = useState(isOpen)
  const [expanded, setExpanded] = useState(isOpen)
  const beginShrink = useGrowOnly()?.beginShrink

  usePendingMessageLayout(present && !isOpen)
  useOpeningLayout(isOpen, expanded, contentRef)

  useLayoutEffect(() => {
    if (isOpen || !present) return
    const finishShrink = beginShrink?.()
    let cancelled = false
    void waitForBlockAnimations(contentRef.current).then(() => {
      if (!cancelled) setPresent(false)
    })
    return () => {
      cancelled = true
      finishShrink?.()
    }
  }, [isOpen, present, beginShrink])

  if (isOpen && !present) setPresent(true)
  if (!isOpen && expanded) setExpanded(false)

  useEffect(() => {
    if (!isOpen) return
    const frame = requestAnimationFrame(() => setExpanded(true))
    return () => cancelAnimationFrame(frame)
  }, [isOpen])

  if (!present) return null

  return (
    <div
      ref={contentRef}
      id={id}
      inert={!isOpen}
      aria-hidden={!isOpen || undefined}
      className={cn(
        'grid transition-[grid-template-rows,opacity] duration-200 ease-in-out motion-reduce:transition-none',
        expanded ? 'opacity-100' : 'pointer-events-none opacity-0',
      )}
      style={{ gridTemplateRows: expanded ? '1fr' : '0fr' }}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  )
}

/** Holds the viewport from the opening commit through the height transition. */
function useOpeningLayout(
  isOpen: boolean,
  expanded: boolean,
  contentRef: React.RefObject<HTMLDivElement | null>,
) {
  const trackPendingLayout = useMessageList()?.trackPendingLayout

  useLayoutEffect(() => {
    if (!isOpen || !trackPendingLayout) return
    const done = trackPendingLayout()
    if (expanded) void waitForBlockAnimations(contentRef.current).then(done)
    return done
  }, [isOpen, expanded, contentRef, trackPendingLayout])
}

/** Waits for the body and its surrounding padding to finish changing size. */
function waitForBlockAnimations(content: HTMLElement | null) {
  if (!content) return Promise.resolve()
  const padding =
    content.parentElement?.getAnimations().filter((animation) => {
      return (
        animation instanceof CSSTransition &&
        animation.transitionProperty === '--work-surface-expansion'
      )
    }) ?? []
  const animations = [...content.getAnimations(), ...padding]
  return Promise.allSettled(animations.map((animation) => animation.finished))
}
