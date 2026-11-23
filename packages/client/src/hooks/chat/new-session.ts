import { useAccountId } from '@/hooks/account-scope'
import {
  getSelectedSessionFolder,
  setSelectedSessionFolder,
} from '@/lib/ui-settings'
import { api } from '@cv/convex/_generated/api'
import type { Id } from '@cv/convex/_generated/dataModel'
import { useQuery } from 'convex/react'
import { useEffect } from 'react'
import { useLocation, useSearch } from 'wouter'

import { useActiveSession } from './session'

/** Remembers the current folder and opens its draft for the next session. */
export function useNewSession() {
  const [, navigate] = useLocation()
  const search = useSearch()
  const params = new URLSearchParams(search)
  const draftFolderId = params.has('id') ? null : params.get('folder')
  const session = useActiveSession()
  const userId = useAccountId()
  const remembered = getSelectedSessionFolder(userId)

  const selectedFolder = useQuery(
    api.sessionFolders.get,
    remembered ? { folderId: remembered as Id<'sessionFolders'> } : 'skip',
  )
  const draftFolder = useQuery(
    api.sessionFolders.get,
    draftFolderId && draftFolderId !== remembered
      ? { folderId: draftFolderId as Id<'sessionFolders'> }
      : 'skip',
  )

  const sessionId = session?._id
  const ownerId = session?.ownerId
  const folderId = session?.folderId

  useEffect(() => {
    if (sessionId && ownerId === userId) {
      setSelectedSessionFolder(userId, folderId ?? null)
    } else if (draftFolder) {
      setSelectedSessionFolder(userId, draftFolder._id)
    }
  }, [userId, sessionId, ownerId, folderId, draftFolder])

  return () => {
    const selected = getSelectedSessionFolder(userId)
    const available =
      selected && (selected !== remembered || selectedFolder !== null)
    if (!available) setSelectedSessionFolder(userId, null)
    navigate(available ? `/?folder=${selected}` : '/', { replace: true })
  }
}
