import { cn, isTouchDevice } from '@/lib/utils'
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react'

const MIN_THUMB = 32
const HIDE_DELAY = 1200
const SCROLL_KEYS = new Set([
  ' ',
  'ArrowDown',
  'ArrowUp',
  'End',
  'Home',
  'PageDown',
  'PageUp',
])

type Geometry = {
  scrollY: number
  scrollHeight: number
  viewport: number
  trackHeight: number
}

type ElementScrollRefs = {
  viewportRef: RefObject<HTMLDivElement | null>
  contentRef: RefObject<HTMLDivElement | null>
}

type OverlayScrollbarProps = {
  element?: ElementScrollRefs
  onNavigate?: () => void
}

export function OverlayScrollbar({
  element,
  onNavigate,
}: OverlayScrollbarProps) {
  const { viewportRef, contentRef } = element ?? {}

  const getScroller = useCallback(
    () => (viewportRef ? viewportRef.current : window),
    [viewportRef],
  )

  const trackRef = useRef<HTMLDivElement>(null)
  const geo = useScrollGeometry(trackRef, getScroller, contentRef)
  const [dragging, setDragging] = useState(false)
  const [active, poke] = useActivity()
  const dragCleanupRef = useRef<(() => void) | null>(null)

  const maxScroll = Math.max(0, geo.scrollHeight - geo.viewport)
  const scrollable = maxScroll > 1 && geo.trackHeight > 0
  const thumbHeight = scrollable
    ? Math.min(
        geo.trackHeight,
        Math.max(
          MIN_THUMB,
          geo.trackHeight * (geo.viewport / geo.scrollHeight),
        ),
      )
    : 0
  const travel = geo.trackHeight - thumbHeight
  const thumbTop = maxScroll > 0 ? (geo.scrollY / maxScroll) * travel : 0

  useEffect(() => () => { dragCleanupRef.current?.() }, []) // prettier-ignore

  useEffect(() => {
    if (viewportRef) {
      const viewport = viewportRef.current
      viewport?.addEventListener('scroll', poke, { passive: true })
      return () => viewport?.removeEventListener('scroll', poke)
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (SCROLL_KEYS.has(event.key)) poke()
    }

    window.addEventListener('wheel', poke, { passive: true })
    window.addEventListener('touchmove', poke, { passive: true })
    window.addEventListener('keydown', onKeyDown)

    return () => {
      window.removeEventListener('wheel', poke)
      window.removeEventListener('touchmove', poke)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [poke, viewportRef])

  const beginDrag = useCallback(
    (
      event: React.PointerEvent,
      scroller: Window | HTMLDivElement,
      startScroll: number,
    ) => {
      event.preventDefault()
      onNavigate?.()

      dragCleanupRef.current?.()

      const el = event.currentTarget as HTMLElement
      const pointerId = event.pointerId
      const startY = event.clientY
      const perPx = travel > 0 ? maxScroll / travel : 0

      setDragging(true)
      el.setPointerCapture(pointerId)

      const cleanup = () => {
        dragCleanupRef.current = null
        setDragging(false)
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onEnd)
        window.removeEventListener('pointercancel', onEnd)
        window.removeEventListener('blur', finishDrag)
        el.removeEventListener('lostpointercapture', finishDrag)
        if (el.hasPointerCapture(pointerId)) {
          el.releasePointerCapture(pointerId)
        }
      }

      const onMove = (e: PointerEvent) => {
        if (e.pointerId !== pointerId) return
        e.preventDefault()
        scroller.scrollTo({ top: startScroll + (e.clientY - startY) * perPx })
      }

      const finishDrag = () => {
        cleanup()
        poke()
      }

      const onEnd = (e: PointerEvent) => {
        if (e.pointerId !== pointerId) return
        finishDrag()
      }

      dragCleanupRef.current = cleanup
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onEnd)
      window.addEventListener('pointercancel', onEnd)
      window.addEventListener('blur', finishDrag)
      el.addEventListener('lostpointercapture', finishDrag)
    },
    [maxScroll, onNavigate, poke, travel],
  )

  const onThumbPointerDown = useCallback(
    (event: React.PointerEvent) => {
      event.stopPropagation()
      const scroller = getScroller()
      if (scroller) beginDrag(event, scroller, readScrollTop(scroller))
    },
    [beginDrag, getScroller],
  )

  const onTrackPointerDown = useCallback(
    (event: React.PointerEvent) => {
      if (isTouchDevice()) return
      const track = trackRef.current
      const scroller = getScroller()
      if (!track || !scroller || travel <= 0) return
      const clickY = event.clientY - track.getBoundingClientRect().top
      const target = Math.min(Math.max(clickY - thumbHeight / 2, 0), travel)
      const scrollTop = (target / travel) * maxScroll

      scroller.scrollTo({ top: scrollTop })
      beginDrag(event, scroller, scrollTop)
    },
    [beginDrag, getScroller, maxScroll, travel, thumbHeight],
  )

  const viewportHeight = viewportRef ? `${geo.viewport}px` : '100dvh'

  return (
    <div className="pointer-events-none sticky top-0 z-20 h-0 shrink-0">
      <div
        ref={trackRef}
        data-slot="overlay-scrollbar"
        aria-hidden="true"
        onPointerDown={onTrackPointerDown}
        onPointerEnter={poke}
        className={cn(
          'group absolute top-1 right-0.5 w-2.5 touch-none select-none',
          scrollable ? 'pointer-events-auto' : 'pointer-events-none',
        )}
        style={{ height: `max(0px, ${viewportHeight} - var(--spacing) * 2)` }}
      >
        <div
          data-slot="overlay-scrollbar-thumb"
          onPointerDown={onThumbPointerDown}
          className={cn(
            'bg-primary absolute right-0 w-1 touch-none rounded-full transition-[opacity,width] duration-150 group-hover:w-2',
            !scrollable && 'opacity-0',
            scrollable && (dragging || active ? 'opacity-100' : 'opacity-0'),
            dragging && 'w-2',
          )}
          style={{
            height: thumbHeight,
            transform: `translateY(${thumbTop}px)`,
          }}
        />
      </div>
    </div>
  )
}

function readScrollTop(scroller: Window | HTMLDivElement) {
  return scroller instanceof HTMLElement ? scroller.scrollTop : scroller.scrollY
}

function useScrollGeometry(
  trackRef: RefObject<HTMLDivElement | null>,
  getScroller: () => Window | HTMLDivElement | null,
  contentRef: ElementScrollRefs['contentRef'] | undefined,
) {
  const [geo, setGeo] = useState<Geometry>({
    scrollY: 0,
    scrollHeight: 0,
    viewport: 0,
    trackHeight: 0,
  })

  useEffect(() => {
    const scroller = getScroller()
    if (!scroller) return
    const viewport = scroller instanceof HTMLElement ? scroller : null
    let raf = 0
    const measure = () => {
      raf = 0
      setGeo({
        scrollY: readScrollTop(scroller),
        scrollHeight:
          viewport?.scrollHeight ?? document.documentElement.scrollHeight,
        viewport: viewport?.clientHeight ?? window.innerHeight,
        trackHeight: trackRef.current?.clientHeight ?? 0,
      })
    }
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(measure)
    }

    measure()

    scroller.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)

    const observer = new ResizeObserver(schedule)
    const content = contentRef ? contentRef.current : document.body
    if (content) observer.observe(content)
    if (viewport) observer.observe(viewport)
    if (trackRef.current) observer.observe(trackRef.current)

    return () => {
      scroller.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      observer.disconnect()
      if (raf) cancelAnimationFrame(raf)
    }
  }, [contentRef, getScroller, trackRef])

  return geo
}

/** Reveals the thumb on activity and fades it after a short idle delay. */
function useActivity(): [boolean, () => void] {
  const [active, setActive] = useState(false)
  const timer = useRef(0)

  const poke = useCallback(() => {
    setActive(true)
    clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setActive(false), HIDE_DELAY)
  }, [])

  useEffect(() => () => clearTimeout(timer.current), [])

  return [active, poke]
}
