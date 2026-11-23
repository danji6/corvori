import type { FolderMenuActions } from '@/components/chat/sessions/folder-menu'
import { useAccountId } from '@/hooks/account-scope'
import { useFolderMoves } from '@/hooks/chat/folder-moves'
import { useFolderPins } from '@/hooks/chat/folder-pins'
import {
  isFolderCollapsed,
  setFolderCollapsed,
} from '@/lib/chat/session-folder-state'
import { uiSettingsStore } from '@/lib/ui-settings'
import type { FolderView } from '@cv/convex/model/session/types'
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'

type FolderHeaderActions = FolderMenuActions & {
  toggle: () => void
  onCollapseAll: () => void
}

type FolderCollapse = Record<string, boolean>

const EMPTY_COLLAPSE: FolderCollapse = {}

/** Keeps folder controls stable while session pages and expansion state change. */
export function useFolderControls(serverFolders: FolderView[]) {
  const store = uiSettingsStore(useAccountId())

  const collapsed = useSyncExternalStore(
    store.subscribe,
    () => store.get().folderCollapse ?? EMPTY_COLLAPSE,
  )

  const setCollapsed = useCallback(
    (update: (current: FolderCollapse) => FolderCollapse) => {
      store.update(({ folderCollapse = EMPTY_COLLAPSE }) => ({
        folderCollapse: update(folderCollapse),
      }))
    },
    [store],
  )

  const [editing, setEditing] = useState<FolderView | 'new' | null>(null)
  const [newParent, setNewParent] = useState<FolderView | undefined>(undefined)
  const [deleting, setDeleting] = useState<FolderView | null>(null)

  const expandParent = useCallback(
    (parentId: string | null) => {
      if (!parentId) return
      const parent = serverFolders.find((folder) => folder._id === parentId)
      setCollapsed((current) => {
        const next = { ...current }
        for (const id of [...(parent?.ancestorIds ?? []), parentId]) {
          delete next[id]
          next[id] = false
        }
        return next
      })
    },
    [serverFolders, setCollapsed],
  )

  const organizing = useFolderMoves(serverFolders, expandParent)
  const folderPins = useFolderPins()
  const { folders, request } = organizing
  const { setPinned } = folderPins

  const toggle = useCallback(
    (key: string) => {
      const folder = folders.find((entry) => entry._id === key)
      setCollapsed((current) =>
        setFolderCollapsed(
          current,
          key,
          !isFolderCollapsed(current, key, folder?.ancestorIds),
        ),
      )
    },
    [folders, setCollapsed],
  )

  const collapseAll = useCallback(
    (folder?: FolderView) => {
      setCollapsed((current) => {
        if (!folder) return { '*': true }
        const own = setFolderCollapsed(current, folder._id, true)
        const next = setFolderCollapsed(own, `branch:${folder._id}`, true)
        for (const entry of folders) {
          if (entry.ancestorIds.includes(folder._id)) {
            delete next[entry._id]
            delete next[`branch:${entry._id}`]
          }
        }
        return next
      })
    },
    [folders, setCollapsed],
  )

  const order = useCallback(
    (folder: FolderView, direction: -1 | 1) => {
      request({
        folderId: folder._id,
        parentId: folder.parentId ?? null,
        direction,
      })
    },
    [request],
  )

  const headers = useMemo(() => {
    const actions = new Map<string, FolderHeaderActions>()
    for (const folder of [undefined, ...folders]) {
      const key = folder?._id ?? 'pinned'
      actions.set(key, {
        toggle: () => toggle(key),
        onCollapseAll: () => collapseAll(folder),
        edit: () => folder && setEditing(folder),
        remove: () => folder && setDeleting(folder),
        reorder: (direction) => folder && order(folder, direction),
        pin: () => {
          if (folder) void setPinned(folder._id, !folder.pinned)
        },
        createChild: () => {
          setNewParent(folder)
          setEditing('new')
        },
        move: () => {
          if (!folder) return
          request(
            { folderId: folder._id, parentId: folder.parentId ?? null },
            true,
          )
        },
      })
    }
    return actions
  }, [folders, toggle, collapseAll, order, request, setPinned])

  function createFolder() {
    setNewParent(undefined)
    setEditing('new')
  }

  const hasExpandedFolders =
    !isFolderCollapsed(collapsed, 'pinned') ||
    folders.some(
      (folder) => !isFolderCollapsed(collapsed, folder._id, folder.ancestorIds),
    )

  return {
    folders,
    collapsed,
    setCollapsed,
    headers,
    collapseAll,
    hasExpandedFolders,
    organizing,
    folderPins,
    pending: organizing.pending || folderPins.pending,
    editing,
    setEditing,
    newParent,
    deleting,
    setDeleting,
    createFolder,
  }
}
