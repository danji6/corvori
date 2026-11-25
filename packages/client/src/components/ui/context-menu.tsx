import { cn } from '@/lib/utils'
import { ChevronRightIcon } from 'lucide-react'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { createPortal, flushSync } from 'react-dom'

type ContextMenuPoint = { x: number; y: number }
type ContextMenuOpenTarget = ContextMenuPoint & { target: Element | null }

type OpenContextMenuPoint = ContextMenuPoint & { key: number }

const LONG_PRESS_MS = 500
const TOUCH_CONTEXT_MENU_WINDOW_MS = 1200
const TOUCH_MOVE_CANCEL = 10
const VIEWPORT_PAD = 8
const SUBMENU_OFFSET = 4

type ContextMenuContextValue = {
  point: OpenContextMenuPoint | null
  menuRef: React.RefObject<HTMLDivElement | null>
  triggerRef: React.RefObject<HTMLDivElement | null>
  triggerProps: React.HTMLAttributes<HTMLElement>
  show: () => void
  close: () => void
}

const ContextMenuContext = createContext<ContextMenuContextValue | null>(null)

type ContextMenuSubContextValue = {
  open: boolean
  openKey: number
  triggerRef: React.RefObject<HTMLButtonElement | null>
  closeNow: () => void
  closeSoon: () => void
  openNow: () => void
}

const ContextMenuSubContext = createContext<ContextMenuSubContextValue | null>(
  null,
)

type SubCoordinator = {
  register: (id: number, forceClose: () => void) => () => void
  activate: (id: number) => void
  deactivate: (id: number) => void
}

const SubCoordinatorContext = createContext<SubCoordinator | null>(null)

let subIdSeq = 0

function createSubCoordinator(): SubCoordinator {
  const callbacks = new Map<number, () => void>()
  let activeId: number | null = null

  return {
    register(id, forceClose) {
      callbacks.set(id, forceClose)
      return () => {
        callbacks.delete(id)
        if (activeId === id) activeId = null
      }
    },
    activate(id) {
      if (activeId === id) return
      activeId = id
      // Close any sibling submenu immediately so it can't linger and overlap
      for (const [otherId, forceClose] of callbacks) {
        if (otherId !== id) forceClose()
      }
    },
    deactivate(id) {
      if (activeId === id) activeId = null
    },
  }
}

function useContextMenu() {
  const ctx = useContext(ContextMenuContext)
  if (!ctx) {
    throw new Error('ContextMenu.* must be used within <ContextMenu>')
  }
  return ctx
}

function useContextMenuSub() {
  const ctx = useContext(ContextMenuSubContext)
  if (!ctx) {
    throw new Error('ContextMenu.Sub* must be used within <ContextMenu.Sub>')
  }
  return ctx
}

type ContextMenuProps = {
  children: React.ReactNode
  onOpen?: (point: ContextMenuOpenTarget) => void
  onOpenChange?: (open: boolean) => void
  disabled?: boolean
}

function ContextMenuRoot({
  children,
  onOpen,
  onOpenChange,
  disabled,
}: ContextMenuProps) {
  const [point, setPoint] = useState<OpenContextMenuPoint | null>(null)
  const [shown, setShown] = useState(false)
  const [subCoordinator] = useState(createSubCoordinator)
  const menuRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLDivElement>(null)
  const openKeyRef = useRef(0)
  const touchStartRef = useRef<ContextMenuPoint | null>(null)
  const longPressRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  )
  const recentTouchUntilRef = useRef(0)
  const touchMenuAttemptedRef = useRef(false)
  const touchCanceledRef = useRef(false)

  function open(x: number, y: number, target: EventTarget | null) {
    onOpen?.({ x, y, target: target instanceof Element ? target : null })
    openKeyRef.current += 1
    setPoint({ x, y, key: openKeyRef.current })
  }

  const show = useCallback(() => setShown(true), [])

  const close = useCallback(() => {
    setPoint(null)
    setShown(false)
  }, [])

  function clearLongPress() {
    if (longPressRef.current) clearTimeout(longPressRef.current)
    longPressRef.current = undefined
  }

  function hasRecentTouch() {
    return Date.now() < recentTouchUntilRef.current
  }

  function openFromTouch(x: number, y: number, target: EventTarget | null) {
    if (touchMenuAttemptedRef.current) return
    touchMenuAttemptedRef.current = true
    clearLongPress()
    open(x, y, target)
  }

  useEffect(() => clearLongPress, [])

  useEffect(() => {
    onOpenChange?.(shown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown])

  const triggerProps: React.HTMLAttributes<HTMLElement> = disabled
    ? {}
    : {
        onContextMenu(event) {
          if (event.shiftKey) return
          const { clientX, clientY, target } = event
          const fromTouch = hasRecentTouch()
          // The click position can change which items render. Commit the
          // popup before the browser decides whether to show its own menu.
          flushSync(() => {
            if (!fromTouch) {
              open(clientX, clientY, target)
            } else if (!touchCanceledRef.current) {
              openFromTouch(clientX, clientY, target)
            }
          })
          if (!hasMenuItems(menuRef.current)) return
          event.preventDefault()
          if (fromTouch) event.stopPropagation()
        },
        onTouchStart(event) {
          if (event.touches.length !== 1) return clearLongPress()
          const touch = event.touches[0]
          const target = event.target
          touchStartRef.current = { x: touch.clientX, y: touch.clientY }
          touchMenuAttemptedRef.current = false
          touchCanceledRef.current = false
          recentTouchUntilRef.current =
            Date.now() + TOUCH_CONTEXT_MENU_WINDOW_MS
          clearLongPress()
          longPressRef.current = setTimeout(() => {
            openFromTouch(touch.clientX, touch.clientY, target)
          }, LONG_PRESS_MS)
        },
        onTouchMove(event) {
          const start = touchStartRef.current
          if (!start || event.touches.length !== 1) return
          const touch = event.touches[0]
          if (
            Math.abs(touch.clientX - start.x) > TOUCH_MOVE_CANCEL ||
            Math.abs(touch.clientY - start.y) > TOUCH_MOVE_CANCEL
          ) {
            touchCanceledRef.current = true
            clearLongPress()
          }
        },
        onTouchEnd() {
          if (!touchMenuAttemptedRef.current) touchCanceledRef.current = true
          clearLongPress()
        },
        onTouchCancel() {
          touchCanceledRef.current = true
          clearLongPress()
        },
      }

  // Dismissal while open
  useEffect(() => {
    if (!shown) return

    function onScroll(event: Event) {
      const target = event.target
      const scrollsTrigger =
        target instanceof Element && target.contains(triggerRef.current)
      if (target === window || target === document || scrollsTrigger) close()
    }

    function onPointerDown(event: PointerEvent) {
      if (event.button === 2) return // right-clicks handled below
      const target = event.target as Element | null
      if (target?.closest('[data-context-menu]')) return
      close()
    }

    function onContextMenu(event: MouseEvent) {
      if (event.shiftKey) return close()

      const target = event.target
      if (!(target instanceof Node)) return close()
      if (triggerRef.current?.contains(target)) return
      const popup = menuRef.current
      if (!popup?.contains(target)) return close()

      event.preventDefault()
      event.stopPropagation()

      // Uncover the hit point before the underlying trigger reads it.
      const { clientX, clientY } = event
      flushSync(close)
      const underneath = document.elementFromPoint(clientX, clientY)
      if (!underneath?.closest('[data-context-menu-trigger]')) return

      underneath.dispatchEvent(new MouseEvent('contextmenu', event))
    }

    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') close()
    }

    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('contextmenu', onContextMenu, true)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
    document.addEventListener('keydown', onKey)

    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('contextmenu', onContextMenu, true)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [shown, close])

  return (
    <ContextMenuContext.Provider
      value={{ point, menuRef, triggerRef, triggerProps, show, close }}
    >
      <SubCoordinatorContext.Provider value={subCoordinator}>
        {children}
      </SubCoordinatorContext.Provider>
    </ContextMenuContext.Provider>
  )
}

function ContextMenuTrigger({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  const { triggerRef, triggerProps } = useContextMenu()

  return (
    <div
      ref={triggerRef}
      data-context-menu-trigger
      className={cn('contents', className)}
      {...triggerProps}
    >
      {children}
    </div>
  )
}

function ContextMenuContent({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  const { point } = useContextMenu()
  if (!point || typeof document === 'undefined') return null

  return createPortal(
    <ContextMenuPopup key={point.key} point={point} className={className}>
      {children}
    </ContextMenuPopup>,
    document.body,
  )
}

type Placement = ContextMenuPoint & {
  flipX: boolean
  flipY: boolean
  anchorKey: number
}

function hasMenuItems(menu: HTMLElement | null) {
  return Boolean(menu?.querySelector('[role="menuitem"]'))
}

function watchMenuItems(menu: HTMLElement, onEmpty: () => void) {
  const observer = new MutationObserver(() => {
    if (!hasMenuItems(menu)) onEmpty()
  })
  observer.observe(menu, { childList: true, subtree: true })
  return () => observer.disconnect()
}

function ContextMenuPopup({
  point,
  children,
  className,
}: {
  point: OpenContextMenuPoint
  children: React.ReactNode
  className?: string
}) {
  const { menuRef, show, close } = useContextMenu()
  const [placement, setPlacement] = useState<Placement | null>(null)
  const [animatedPlacementKey, setAnimatedPlacementKey] = useState<
    number | null
  >(null)

  useLayoutEffect(() => {
    const el = menuRef.current
    if (!el) return
    if (!hasMenuItems(el)) {
      close()
      return
    }

    const rect = el.getBoundingClientRect()

    let nx = point.x
    let ny = point.y

    const flipX = nx + rect.width > window.innerWidth - VIEWPORT_PAD
    const flipY = ny + rect.height > window.innerHeight - VIEWPORT_PAD
    if (flipX) nx = Math.max(VIEWPORT_PAD, point.x - rect.width)
    if (flipY) ny = Math.max(VIEWPORT_PAD, point.y - rect.height)

    setPlacement({
      x: Math.max(VIEWPORT_PAD, nx),
      y: Math.max(VIEWPORT_PAD, ny),
      flipX,
      flipY,
      anchorKey: point.key,
    })
    show()
    return watchMenuItems(el, close)
  }, [point, menuRef, show, close])

  const currentPlacement =
    placement?.anchorKey === point.key ? placement : undefined
  const canAnimate = animatedPlacementKey === currentPlacement?.anchorKey

  useEffect(() => {
    if (!currentPlacement) return
    const frame = requestAnimationFrame(() => {
      setAnimatedPlacementKey(currentPlacement.anchorKey)
    })
    return () => cancelAnimationFrame(frame)
  }, [currentPlacement])

  const origin = currentPlacement
    ? `${currentPlacement.flipX ? 'right' : 'left'} ${currentPlacement.flipY ? 'bottom' : 'top'}`
    : undefined

  return (
    <div
      ref={menuRef}
      data-context-menu
      role="menu"
      style={{
        position: 'fixed',
        left: currentPlacement?.x ?? 0,
        top: currentPlacement?.y ?? 0,
        maxWidth: `calc(100vw - ${VIEWPORT_PAD * 2}px)`,
        transformOrigin: origin,
        zIndex: 50,
      }}
      className={cn(
        'bg-popover text-popover-foreground ring-foreground/10 min-w-36 overflow-visible rounded-lg p-1 shadow-md ring-1 transition-[opacity,scale] duration-100',
        canAnimate
          ? 'scale-100 opacity-100'
          : 'pointer-events-none scale-95 opacity-0',
        className,
      )}
    >
      {children}
    </div>
  )
}

function ContextMenuItem({
  children,
  onSelect,
  variant = 'default',
  disabled,
  className,
}: {
  children: React.ReactNode
  onSelect?: () => void
  variant?: 'default' | 'destructive'
  disabled?: boolean
  className?: string
}) {
  const { close } = useContextMenu()
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={() => {
        if (disabled) return
        onSelect?.()
        close()
      }}
      className={cn(
        'hover:bg-m3-surface-container-high relative flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-2 text-left text-sm outline-hidden select-none disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
        variant === 'destructive' &&
          'text-destructive hover:bg-destructive/10 [&_svg]:text-destructive',
        className,
      )}
    >
      {children}
    </button>
  )
}

function ContextMenuSub({ children }: { children: React.ReactNode }) {
  const coordinator = useContext(SubCoordinatorContext)
  const [id] = useState(() => ++subIdSeq)

  const [open, setOpen] = useState(false)
  const [openKey, setOpenKey] = useState(0)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  )

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
    closeTimerRef.current = undefined
  }, [])

  const closeNow = useCallback(() => {
    clearCloseTimer()
    coordinator?.deactivate(id)
    setOpen(false)
  }, [clearCloseTimer, coordinator, id])

  function openNow() {
    clearCloseTimer()
    coordinator?.activate(id)
    if (!open) setOpenKey((key) => key + 1)
    setOpen(true)
  }

  function closeSoon() {
    clearCloseTimer()
    closeTimerRef.current = setTimeout(closeNow, 120)
  }

  function closeSoonForMouse(event: React.PointerEvent) {
    if (event.pointerType === 'mouse') closeSoon()
  }

  // Let the coordinator force this submenu closed the instant a sibling opens
  useEffect(
    () => coordinator?.register(id, closeNow),
    [coordinator, id, closeNow],
  )

  useEffect(() => clearCloseTimer, [clearCloseTimer])

  return (
    <ContextMenuSubContext.Provider
      value={{ open, openKey, triggerRef, closeNow, closeSoon, openNow }}
    >
      <div role="none" className="relative" onPointerLeave={closeSoonForMouse}>
        {children}
      </div>
    </ContextMenuSubContext.Provider>
  )
}

function ContextMenuSubTrigger({
  children,
  disabled,
  className,
}: {
  children: React.ReactNode
  disabled?: boolean
  className?: string
}) {
  const { open, triggerRef, closeSoon, openNow } = useContextMenuSub()
  const lastPointerTypeRef = useRef<string | null>(null)

  return (
    <button
      ref={triggerRef}
      type="button"
      role="menuitem"
      aria-haspopup="menu"
      aria-expanded={open}
      disabled={disabled}
      onPointerDown={(event) => {
        lastPointerTypeRef.current = event.pointerType
      }}
      onPointerEnter={(event) => {
        if (event.pointerType === 'mouse') openNow()
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === 'mouse') closeSoon()
      }}
      onFocus={() => {
        if (lastPointerTypeRef.current !== 'touch') openNow()
      }}
      onClick={() => {
        if (disabled) return
        openNow()
      }}
      className={cn(
        'hover:bg-m3-surface-container-high aria-expanded:bg-m3-surface-container-high relative flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-2 text-left text-sm outline-hidden select-none disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
        className,
      )}
    >
      {children}
      <ChevronRightIcon className="ml-auto" />
    </button>
  )
}

type SubPlacement = {
  left: number
  top: number
  maxWidth: number
  openKey: number
}

function ContextMenuSubContent({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  const { open, openKey, triggerRef, closeNow, closeSoon, openNow } =
    useContextMenuSub()
  const ref = useRef<HTMLDivElement>(null)
  const [placement, setPlacement] = useState<SubPlacement | null>(null)
  const [animatedOpenKey, setAnimatedOpenKey] = useState<number | null>(null)

  useLayoutEffect(() => {
    if (!open) return

    const trigger = triggerRef.current
    const el = ref.current
    if (!trigger || !el) return
    if (!hasMenuItems(el)) {
      closeNow()
      return
    }

    const triggerRect = trigger.getBoundingClientRect()

    const rect = el.getBoundingClientRect()

    const spaceRight =
      window.innerWidth - VIEWPORT_PAD - triggerRect.right - SUBMENU_OFFSET
    const spaceLeft = triggerRect.left - VIEWPORT_PAD - SUBMENU_OFFSET
    const opensRight = rect.width <= spaceRight || spaceRight >= spaceLeft
    const maxWidth = Math.max(0, opensRight ? spaceRight : spaceLeft)
    const width = Math.min(rect.width, maxWidth)

    const top =
      Math.min(
        Math.max(VIEWPORT_PAD, triggerRect.top - 4),
        window.innerHeight - rect.height - VIEWPORT_PAD,
      ) - triggerRect.top

    const left = opensRight
      ? triggerRect.width + SUBMENU_OFFSET
      : -width - SUBMENU_OFFSET

    setPlacement({ left, top, maxWidth, openKey })
    return watchMenuItems(el, closeNow)
  }, [open, openKey, triggerRef, closeNow])

  const currentPlacement =
    placement?.openKey === openKey ? placement : undefined
  const currentOpenKey = currentPlacement?.openKey
  const canAnimate = animatedOpenKey === currentOpenKey

  useEffect(() => {
    if (currentOpenKey === undefined) return
    const frame = requestAnimationFrame(() => {
      setAnimatedOpenKey(currentOpenKey)
    })
    return () => cancelAnimationFrame(frame)
  }, [currentOpenKey])

  if (!open) return null

  return (
    <div
      ref={ref}
      data-context-menu
      role="menu"
      style={{
        position: 'absolute',
        left: currentPlacement?.left ?? `calc(100% + ${SUBMENU_OFFSET}px)`,
        top: currentPlacement?.top ?? -4,
        width: 'max-content',
        maxWidth: currentPlacement?.maxWidth,
        minWidth: currentPlacement
          ? Math.min(144, currentPlacement.maxWidth)
          : undefined,
        zIndex: 60,
      }}
      onPointerEnter={openNow}
      onPointerLeave={(event) => {
        if (event.pointerType === 'mouse') closeSoon()
      }}
      className={cn(
        'bg-popover text-popover-foreground ring-foreground/10 min-w-36 overflow-hidden rounded-lg p-1 shadow-lg ring-1 transition-[opacity,scale] duration-100',
        canAnimate
          ? 'scale-100 opacity-100'
          : 'pointer-events-none scale-95 opacity-0',
        className,
      )}
    >
      {children}
    </div>
  )
}

function ContextMenuSeparator({ className }: { className?: string }) {
  return (
    <div
      role="separator"
      className={cn('bg-border -mx-1 my-1 h-px', className)}
    />
  )
}

export const ContextMenu = Object.assign(ContextMenuRoot, {
  Trigger: ContextMenuTrigger,
  Content: ContextMenuContent,
  Item: ContextMenuItem,
  Sub: ContextMenuSub,
  SubTrigger: ContextMenuSubTrigger,
  SubContent: ContextMenuSubContent,
  Separator: ContextMenuSeparator,
})

export type { ContextMenuOpenTarget, ContextMenuPoint, ContextMenuProps }
