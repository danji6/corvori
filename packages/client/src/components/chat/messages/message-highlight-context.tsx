import { createOptionalContext } from '@/hooks/context'
import type { MessageRow } from '@/lib/chat/rows'
import { cn } from '@/lib/utils'
import { AnimatePresence, motion } from 'motion/react'
import {
  type RefObject,
  useCallback,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

export type HighlightTarget = {
  messageId: string
  /** The segment holding the block, or null for the whole message. */
  segmentIndex: number | null
  /** The block to highlight, or null to highlight the whole message. */
  groupIndex: number | null
  surface?: 'header' | 'background'
}

type HighlightSelection = HighlightTarget | { attachment: HTMLElement }

export type MessageHighlightValue = {
  target: HighlightSelection | null
  setTarget: React.Dispatch<React.SetStateAction<HighlightSelection | null>>
  registerElement: (target: HighlightTarget, element: HTMLElement) => () => void
}

export const [MessageHighlightContext, useMessageHighlight] =
  createOptionalContext<MessageHighlightValue>()

export type HighlightElements = Map<HTMLElement, HighlightTarget>

const [MessageHighlightElementsContext, useMessageHighlightElements] =
  createOptionalContext<RefObject<HighlightElements>>()

export { useMessageHighlightElements }

const [HighlightRegistryVersionContext, useHighlightRegistryVersion] =
  createOptionalContext<number>()

/** Targets the block a row renders, falling back to the whole message. */
export function highlightTargetForRow(
  messageId: string,
  row: MessageRow | null | undefined,
): HighlightTarget {
  if (row?.kind !== 'group') {
    return { messageId, segmentIndex: null, groupIndex: null }
  }
  return {
    messageId,
    segmentIndex: row.segmentIndex,
    groupIndex: row.groupIndex,
  }
}

type HighlightTargetInput = HighlightTarget | string

function resolveHighlightTarget(target: HighlightTargetInput): HighlightTarget {
  if (typeof target !== 'string') return target
  return { messageId: target, segmentIndex: null, groupIndex: null }
}

function useResolvedHighlightTarget(targetInput: HighlightTargetInput) {
  const { messageId, segmentIndex, groupIndex, surface } =
    resolveHighlightTarget(targetInput)
  return useMemo(
    () => ({ messageId, segmentIndex, groupIndex, surface }),
    [messageId, segmentIndex, groupIndex, surface],
  )
}

/** Registers an element for a highlight target. */
export function useMessageHighlightRef(targetInput: HighlightTargetInput) {
  const registerElement = useMessageHighlight()?.registerElement
  const target = useResolvedHighlightTarget(targetInput)
  return useCallback(
    (element: HTMLElement | null) => {
      if (element) return registerElement?.(target, element)
    },
    [registerElement, target],
  )
}

export function useMessageHighlightMenu(targetInput: HighlightTargetInput) {
  const setTarget = useMessageHighlight()?.setTarget
  const target = useResolvedHighlightTarget(targetInput)
  const ownsHighlightRef = useRef(false)

  return useCallback(
    (open: boolean) => {
      if (!setTarget) return
      if (open) {
        ownsHighlightRef.current = true
        setTarget(target)
      } else if (ownsHighlightRef.current) {
        ownsHighlightRef.current = false
        setTarget(null)
      }
    },
    [setTarget, target],
  )
}

type HighlightRect = {
  top: number
  left: number
  width: number
  height: number
  borderRadius?: string
}

export const MESSAGE_HIGHLIGHT_PADDING = 12

function keyForTarget(target: HighlightTarget): string {
  if (target.groupIndex === null) return `${target.messageId}:message`
  return `${target.messageId}:s${target.segmentIndex ?? 0}:${target.groupIndex}${target.surface ? ':header' : ''}`
}

export function MessageHighlightProvider({
  children,
}: {
  children: React.ReactNode
}) {
  const [target, setTarget] = useState<HighlightSelection | null>(null)
  const [registryVersion, setRegistryVersion] = useState(0)
  const elementsRef = useRef<HighlightElements>(new Map())

  const registerElement = useCallback(
    (target: HighlightTarget, element: HTMLElement) => {
      elementsRef.current.set(element, target)
      setRegistryVersion((version) => version + 1)

      return () => {
        if (elementsRef.current.get(element) !== target) return
        elementsRef.current.delete(element)
        setRegistryVersion((version) => version + 1)
      }
    },
    [],
  )

  useLayoutEffect(() => {
    if (!target) return

    const dismissOnOutsidePress = (event: PointerEvent) => {
      const bounds = measureTarget(target, elementsRef.current)
      if (bounds && containsPoint(bounds, event)) return

      setTarget((current) => (current === target ? null : current))
    }

    window.addEventListener('pointerdown', dismissOnOutsidePress, true)
    return () =>
      window.removeEventListener('pointerdown', dismissOnOutsidePress, true)
  }, [target])

  const value = useMemo(
    () => ({ target, setTarget, registerElement }),
    [target, registerElement],
  )
  return (
    <MessageHighlightContext.Provider value={value}>
      <MessageHighlightElementsContext value={elementsRef}>
        <HighlightRegistryVersionContext value={registryVersion}>
          {children}
        </HighlightRegistryVersionContext>
      </MessageHighlightElementsContext>
    </MessageHighlightContext.Provider>
  )
}

type MessageHighlightLayerProps = {
  root: RefObject<HTMLElement | null>
  rows: readonly MessageRow[]
  layoutVersion: number
}

/** Anchors the overlay to the same scrolling container as the virtual rows. */
export function MessageHighlightLayer(props: MessageHighlightLayerProps) {
  const target = useMessageHighlight()?.target
  const rect = useHighlightRect(target, props)
  return <MessageHighlightOverlay rect={target ? rect : null} />
}

function useHighlightRect(
  target: HighlightSelection | null | undefined,
  { root, rows, layoutVersion }: MessageHighlightLayerProps,
) {
  const elementsRef = useMessageHighlightElements()
  const registryVersion = useHighlightRegistryVersion()
  const [rect, setRect] = useState<HighlightRect | null>(null)

  const measure = useEffectEvent(() => {
    const container = root.current
    const next =
      target && elementsRef && container
        ? measureInTranscript(target, elementsRef.current, container)
        : null
    setRect((current) => (sameRect(current, next) ? current : next))
  })

  useLayoutEffect(() => {
    if (target) return
    const frame = requestAnimationFrame(() => measure())
    return () => cancelAnimationFrame(frame)
  }, [target])

  useLayoutEffect(() => {
    if (!target || !elementsRef) return

    const attachment = 'attachment' in target ? target.attachment : null
    function onScroll(event: Event) {
      if (
        event.target instanceof Element &&
        event.target.contains(attachment)
      ) {
        measure()
      }
    }

    const observer = new ResizeObserver(() => measure())
    const frame = requestAnimationFrame(() => {
      if (root.current) observer.observe(root.current)
      const elements = getTargetElements(target, elementsRef.current)
      for (const element of elements) observer.observe(element)
    })
    if (attachment) window.addEventListener('scroll', onScroll, true)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      if (attachment) window.removeEventListener('scroll', onScroll, true)
    }
  }, [elementsRef, registryVersion, root, target])

  useLayoutEffect(() => {
    if (!target) return
    // A virtual row can change its offset without changing its size.
    const frame = requestAnimationFrame(() => measure())
    return () => cancelAnimationFrame(frame)
  }, [elementsRef, layoutVersion, registryVersion, root, rows, target])

  return rect
}

function measureInTranscript(
  target: HighlightSelection,
  elements: Map<HTMLElement, HighlightTarget>,
  container: HTMLElement,
): HighlightRect | null {
  const bounds = measureTarget(target, elements)
  if (!bounds) return null

  const origin = container.getBoundingClientRect()
  return {
    ...bounds,
    top: bounds.top - origin.top,
    left: bounds.left - origin.left,
  }
}

function sameRect(a: HighlightRect | null, b: HighlightRect | null) {
  if (!a || !b) return a === b
  return (
    a.top === b.top &&
    a.left === b.left &&
    a.width === b.width &&
    a.height === b.height &&
    a.borderRadius === b.borderRadius
  )
}

function getTargetElements(
  target: HighlightSelection,
  elements: Map<HTMLElement, HighlightTarget>,
): HTMLElement[] {
  if ('attachment' in target) return [target.attachment]
  if (target.groupIndex === null) {
    const surfaces: HTMLElement[] = []
    const content: HTMLElement[] = []
    for (const [element, registeredTarget] of elements) {
      if (registeredTarget.messageId !== target.messageId) continue
      if (registeredTarget.surface === 'background') surfaces.push(element)
      else content.push(element)
    }
    return surfaces.length ? surfaces : content
  }

  const targetKey = keyForTarget(target)
  return Array.from(elements.entries())
    .filter(
      ([, registeredTarget]) => keyForTarget(registeredTarget) === targetKey,
    )
    .map(([element]) => element)
}

function measureTarget(
  target: HighlightSelection,
  elements: Map<HTMLElement, HighlightTarget>,
): HighlightRect | null {
  if ('attachment' in target) return measureAttachment(target.attachment)

  const matching = getTargetElements(target, elements)
  const surface = matching[0]
  if (surface?.isConnected && elements.get(surface)?.surface === 'background') {
    const { top, left, width, height } = surface.getBoundingClientRect()
    if (!width || !height) return null
    return {
      top,
      left,
      width,
      height,
      borderRadius: getComputedStyle(surface).borderRadius,
    }
  }

  const rects = matching
    .filter((element) => element.isConnected)
    .map((element) => element.getBoundingClientRect())
    .filter((rect) => rect.width > 0 && rect.height > 0)

  if (!rects.length) return null

  const first = rects[0]
  const union = rects.slice(1).reduce(
    (acc, rect) => ({
      top: Math.min(acc.top, rect.top),
      left: Math.min(acc.left, rect.left),
      right: Math.max(acc.right, rect.right),
      bottom: Math.max(acc.bottom, rect.bottom),
    }),
    {
      top: first.top,
      left: first.left,
      right: first.right,
      bottom: first.bottom,
    },
  )

  return padHighlightBounds(union)
}

function measureAttachment(attachment: HTMLElement): HighlightRect | null {
  if (!attachment.isConnected) return null

  const bounds = attachment.getBoundingClientRect()
  // Keep the surface on the visible portion of a horizontally scrolling strip.
  const strip = attachment.closest('[data-slot="file-block"]')
  const clip = strip?.getBoundingClientRect()
  const left = Math.max(bounds.left, clip?.left ?? bounds.left)
  const right = Math.min(bounds.right, clip?.right ?? bounds.right)
  if (right <= left || bounds.height <= 0) return null

  return padHighlightBounds({
    top: bounds.top,
    bottom: bounds.bottom,
    left,
    right,
  })
}

function padHighlightBounds({
  top,
  bottom,
  left,
  right,
}: Pick<DOMRectReadOnly, 'top' | 'bottom' | 'left' | 'right'>): HighlightRect {
  return {
    top: top - MESSAGE_HIGHLIGHT_PADDING,
    left: left - MESSAGE_HIGHLIGHT_PADDING,
    width: right - left + MESSAGE_HIGHLIGHT_PADDING * 2,
    height: bottom - top + MESSAGE_HIGHLIGHT_PADDING * 2,
  }
}

function containsPoint(rect: HighlightRect, { clientX, clientY }: MouseEvent) {
  return (
    clientX >= rect.left &&
    clientX < rect.left + rect.width &&
    clientY >= rect.top &&
    clientY < rect.top + rect.height
  )
}

function MessageHighlightOverlay({ rect }: { rect: HighlightRect | null }) {
  return (
    <AnimatePresence initial={false}>
      {rect && (
        <motion.div
          key="message-highlight"
          data-slot="message-highlight"
          aria-hidden
          initial={{
            opacity: 0,
            top: rect.top,
            left: rect.left,
            width: rect.width,
            height: rect.height,
          }}
          animate={{
            opacity: 1,
            top: rect.top,
            left: rect.left,
            width: rect.width,
            height: rect.height,
          }}
          exit={{ opacity: 0 }}
          style={{ borderRadius: rect.borderRadius }}
          transition={{ duration: 0.12, ease: 'easeOut' }}
          className={cn(
            'chat-message-highlight bg-m3-surface-container/70 ring-m3-outline-variant/40 pointer-events-none absolute z-0 ring-1',
            rect.borderRadius && 'ring-inset',
          )}
        />
      )}
    </AnimatePresence>
  )
}
