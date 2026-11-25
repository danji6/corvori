import { createLocalStorageStore } from '@/lib/local-storage-store'
import { supportsDesktopNotifications } from '@/lib/notification-desktop'
import { toastError } from '@/lib/notifications'
import { APP_ID } from '@cv/core/const'
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'

type DesktopPermission = NotificationPermission | 'unsupported'
type DesktopPreferences = { enabled?: boolean; permissionDecided?: boolean }

const preferences = createLocalStorageStore<DesktopPreferences>(
  `${APP_ID}:desktop-notifications`,
)
let requestedOnThisPage = false

function useDesktopPermission() {
  const [permission, setPermission] = useState<DesktopPermission>(readPermission) // prettier-ignore
  const [saving, setSaving] = useState(false)
  const requesting = useRef(false)

  useEffect(() => {
    const refresh = () => setPermission(readPermission())
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [])

  const requestPermission = useCallback(async () => {
    if (requesting.current) return false
    requesting.current = true
    requestedOnThisPage = true
    setSaving(true)
    try {
      await Notification.requestPermission()
      const next = readPermission()
      setPermission(next)
      if (next === 'granted' || next === 'denied') {
        preferences.set({ permissionDecided: true })
      }
      return next === 'granted'
    } catch (error) {
      toastError(error)
      return false
    } finally {
      requesting.current = false
      setSaving(false)
    }
  }, [])

  return { permission, setPermission, requestPermission, saving }
}

/** Combines the browser-local delivery preference with native permission. */
export function useNotificationPreferences() {
  const { enabled = true, permissionDecided } = useSyncExternalStore(
    preferences.subscribe,
    preferences.get,
  )
  const { permission, setPermission, requestPermission, saving } = useDesktopPermission() // prettier-ignore
  useFirstPermissionRequest(
    enabled && !permissionDecided && permission === 'default',
    requestPermission,
  )

  const setEnabled = useCallback(
    async (value: boolean) => {
      if (!value) {
        preferences.set({ enabled: false })
        return
      }
      const current = readPermission()
      setPermission(current)
      if (current === 'default') {
        if (!(await requestPermission())) return
      } else if (current !== 'granted') return
      preferences.set({ enabled: true })
    },
    [requestPermission, setPermission],
  )

  return {
    desktopPermission: permission,
    desktopEnabled: enabled && permission === 'granted',
    desktopSaving: saving,
    setDesktopEnabled: setEnabled,
  }
}

function useFirstPermissionRequest(
  canPrompt: boolean,
  requestPermission: () => Promise<boolean>,
) {
  useEffect(() => {
    if (!canPrompt || requestedOnThisPage) return

    function onInteraction(event: MouseEvent | KeyboardEvent) {
      if (requestedOnThisPage) return
      if (!event.isTrusted || navigator.userActivation?.isActive === false)
        return
      if (
        event instanceof KeyboardEvent &&
        (event.repeat || event.key === 'Escape')
      )
        return
      if (readPermission() !== 'default') return
      void requestPermission()
    }

    window.addEventListener('click', onInteraction, true)
    window.addEventListener('keydown', onInteraction, true)
    return () => {
      window.removeEventListener('click', onInteraction, true)
      window.removeEventListener('keydown', onInteraction, true)
    }
  }, [canPrompt, requestPermission])
}

function readPermission(): DesktopPermission {
  return supportsDesktopNotifications()
    ? Notification.permission
    : 'unsupported'
}
