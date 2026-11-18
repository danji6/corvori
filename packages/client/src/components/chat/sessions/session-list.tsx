import {
  AnimatedToolbar,
  ConfirmDialog,
  RippleButton,
  Tooltip,
} from '@/components/ui'
import { useSession, useSessionGroups } from '@/hooks/chat'
import { useFolderControls } from '@/hooks/chat/folder-controls'
import { PAGE_STEP } from '@/hooks/chat/pagination-window'
import {
  type FolderDropPlacement,
  folderDropIntent,
} from '@/lib/chat/folder-moves'
import { isFolderCollapsed } from '@/lib/chat/session-folder-state'
import {
  type GroupRow,
  flattenSessionGroups,
  flattenSessionTree,
} from '@/lib/chat/session-groups'
import { toastError } from '@/lib/notifications'
import { api } from '@cv/convex/_generated/api'
import type { Id } from '@cv/convex/_generated/dataModel'
import type { FolderView } from '@cv/convex/types'
import {
  DndContext,
  type DragEndEvent,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  closestCenter,
  pointerWithin,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import { useAction, useMutation } from 'convex/react'
import { ChevronsDownUpIcon, FolderPlusIcon } from 'lucide-react'
import { memo, useMemo, useRef, useState } from 'react'

import { useUnreadNotificationSessionIds } from '../notifications/notification-provider'
import { FolderDialog } from './folder-dialog'
import { FolderGroupRow } from './folder-group-row'
import { FolderHeader } from './folder-header'
import { FolderMoveDialog } from './folder-move-dialog'
import { PaginationButtons } from './pagination-buttons'
import { SessionListMenu } from './session-list-menu'
import { SessionListRow } from './session-list-row'
import { SessionListScrollArea } from './session-list-scroll-area'
import type { SessionPageControls } from './session-page'
import { SessionSearch } from './session-search'
import { SessionTitleEditor } from './session-title-editor'
import { SessionTree } from './session-tree'

// Keep sensor identity stable so folder toggles don't update every draggable.
const MOUSE_SENSOR_OPTIONS = { activationConstraint: { distance: 8 } }

export const SessionListView = memo(function SessionListView({
  streamingEnabled = true,
}: {
  streamingEnabled?: boolean
}) {
  const {
    pages,
    folders: serverFolders,
    search,
    pendingSessionIds,
    dropSession,
  } = useSessionGroups()

  const unreadSessionIds = useUnreadNotificationSessionIds()
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const menuTrigger = useRef<HTMLButtonElement>(null)
  const scrollArea = useRef<HTMLDivElement>(null)

  const {
    folders,
    collapsed,
    setCollapsed,
    headers,
    collapseAll,
    hasExpandedFolders,
    organizing,
    folderPins,
    pending: organizationPending,
    editing,
    setEditing,
    newParent,
    deleting,
    setDeleting,
    createFolder,
  } = useFolderControls(serverFolders)

  const [dragTitle, setDragTitle] = useState<string | null>(null)
  const [frozenRows, setFrozenRows] = useState<GroupRow[] | null>(null)

  const change = useAction(api.actions.folders.change)

  const sensors = useSensors(
    useSensor(MouseSensor, MOUSE_SENSOR_OPTIONS),
    useSensor(KeyboardSensor),
  )

  const liveRows = useMemo(
    () =>
      search.trim()
        ? flattenSessionGroups(['search'], pages, {})
        : [
            ...flattenSessionTree(folders, pages, {}),
            ...flattenSessionGroups(['recents'], pages, {}),
          ],
    [search, pages, folders],
  )
  const rows = frozenRows ?? liveRows
  const foldersById = useMemo(
    () =>
      new Map<string, FolderView>(
        folders.map((folder) => [folder._id, folder]),
      ),
    [folders],
  )

  async function drop(event: DragEndEvent) {
    setFrozenRows(null)
    setDragTitle(null)
    const { active, over } = event
    if (!over || organizationPending) return

    try {
      if (active.data.current?.kind === 'folder') {
        const target = over.data.current
        if (target?.kind === 'folder-pin') {
          const pinned = await folderPins.setPinned(
            active.id as Id<'sessionFolders'>,
            true,
          )
          if (pinned) setCollapsed((current) => ({ ...current, pinned: false }))
          return
        }
        if (target?.kind === 'folder-target') {
          const input = folderDropIntent(
            folders,
            String(active.id),
            target.folderId,
            target.placement as FolderDropPlacement,
          )
          if (input) organizing.request(input)
        }
        return
      }

      const source = active.data.current
      const sessionId = source?.sessionId as Id<'sessions'> | undefined
      if (!sessionId) return

      const target = String(over.data.current?.groupKey ?? over.id)
      if (source?.groupKey === 'recents' && target === 'recents') return
      const item = findDragSession(sessionId)
      if (item)
        await dropSession(item, target === 'recents' ? 'ungrouped' : target)
    } catch (err) {
      toastError(err, 'Could not organize session')
    }
  }

  function findDragSession(id: string | undefined) {
    if (!id) return undefined
    const matches = (session: { _id: string }) => session._id === id
    return (
      pages.recents?.results.find(matches) ??
      Object.values(pages)
        .flatMap((page) => page.results)
        .find(matches)
    )
  }

  function renderRow(row: GroupRow, controls?: SessionPageControls) {
    if (row.kind === 'session') {
      return (
        <SessionListRow
          row={row}
          pending={organizationPending}
          dropPending={organizationPending || pendingSessionIds.has(row.id)}
          hasSources={Boolean(foldersById.get(row.key)?.workspace)}
          hasUnreadNotification={unreadSessionIds.has(row.id)}
          showFolder={Boolean(search.trim())}
          rename={setRenamingId}
        />
      )
    }
    const content = renderRowContent(row, controls)
    if (['search', 'recents', 'folders'].includes(row.key)) return content
    return (
      <FolderGroupRow
        row={row}
        last={Boolean(row.last)}
        pending={organizationPending}
        hasSources={Boolean(foldersById.get(row.key)?.workspace)}
      >
        {content}
      </FolderGroupRow>
    )
  }

  function renderRowContent(row: GroupRow, controls?: SessionPageControls) {
    const folder = foldersById.get(row.key)
    if (row.kind === 'header') {
      return (
        <FolderHeader
          groupKey={row.key}
          folder={folder}
          collapsed={isFolderCollapsed(collapsed, row.key, folder?.ancestorIds)}
          pending={organizationPending}
          {...headers.get(row.key)!}
        />
      )
    }

    const page = pages[row.key]
    if (!page || page.status === 'LoadingFirstPage') return null

    if (
      row.key === 'search' &&
      page.status === 'Exhausted' &&
      !page.results.length
    ) {
      return (
        <div className="text-muted-foreground px-2 py-1 text-xs">
          No matching sessions
        </div>
      )
    }

    return (
      <PaginationButtons
        onShowLess={controls?.showLess ?? page.showLess}
        onShowMore={
          page.status !== 'Exhausted'
            ? (controls?.loadMore ?? (() => page.loadMore(PAGE_STEP)))
            : undefined
        }
        disabled={page.status === 'LoadingMore' || controls?.revealing}
      />
    )
  }

  return (
    <DndContext
      sensors={sensors}
      autoScroll={false}
      collisionDetection={(args) => {
        const pointer = args.pointerCoordinates
        if (!pointer) return closestCenter(args)
        const bounds = scrollArea.current?.getBoundingClientRect()
        if (bounds && (pointer.y < bounds.top || pointer.y > bounds.bottom))
          return []
        return pointerWithin(args)
      }}
      onDragStart={({ active }) => {
        setFrozenRows(liveRows)
        const session = findDragSession(active.data.current?.sessionId)
        setDragTitle(
          session?.title ||
            session?.firstMessagePreview ||
            folders.find((folder) => folder._id === active.id)?.name ||
            'New chat',
        )
      }}
      onDragCancel={() => {
        setFrozenRows(null)
        setDragTitle(null)
      }}
      onDragEnd={(event) => void drop(event)}
    >
      <div className="flex h-full min-h-0 flex-col gap-2">
        <header className="flex flex-col gap-2 px-3">
          <div className="flex items-center justify-between gap-2">
            <span className="ml-2 font-bold">Sessions</span>
            <AnimatedToolbar>
              <RippleButton
                variant="stealth"
                size="icon"
                aria-label="New folder"
                disabled={organizationPending}
                onClick={createFolder}
              >
                <FolderPlusIcon />
              </RippleButton>
              <AnimatedToolbar.Item visible={hasExpandedFolders}>
                <Tooltip>
                  <Tooltip.Trigger
                    render={
                      <RippleButton
                        variant="stealth"
                        size="icon"
                        className="focus-visible:ring-inset"
                        aria-label="Collapse all folders"
                        onClick={() => {
                          collapseAll()
                          menuTrigger.current?.focus()
                        }}
                      >
                        <ChevronsDownUpIcon />
                      </RippleButton>
                    }
                  />
                  <Tooltip.Content>Collapse all folders</Tooltip.Content>
                </Tooltip>
              </AnimatedToolbar.Item>
              <SessionListMenu ref={menuTrigger} />
            </AnimatedToolbar>
          </div>
          <SessionSearch />
        </header>
        <SessionListScrollArea ref={scrollArea}>
          <SessionTree
            streamingEnabled={streamingEnabled}
            rows={rows}
            collapsed={collapsed}
            renderRow={renderRow}
            search={search}
            pages={pages}
            dragging={Boolean(frozenRows)}
            organizationPending={organizationPending}
          />
        </SessionListScrollArea>
        {renamingId && (
          <SessionRenameDialog
            id={renamingId}
            onClose={() => setRenamingId(null)}
          />
        )}
        {editing && (
          <FolderDialog
            key={editing === 'new' ? 'new' : editing._id}
            folder={editing === 'new' ? undefined : editing}
            parent={editing === 'new' ? newParent : undefined}
            onClose={() => setEditing(null)}
          />
        )}
        {organizing.intent &&
          folders.find(
            (folder) => folder._id === organizing.intent?.folderId,
          ) && (
            <FolderMoveDialog
              key={organizing.intent.folderId}
              folder={folders.find(
                (folder) => folder._id === organizing.intent?.folderId,
              )!}
              intent={organizing.intent}
              chooseParent={organizing.chooseParent}
              onMove={organizing.apply}
              onClose={organizing.cancel}
            />
          )}
        <ConfirmDialog
          open={Boolean(deleting)}
          onOpenChange={(open) => !open && setDeleting(null)}
          title="Delete folder?"
          description={`This folder and all its subfolders will be deleted. Sessions will move to ${folders.find((folder) => folder._id === deleting?.parentId)?.folderPath ?? 'no folder'}.${deleting?.parentId ? '' : ' Folder-provided filesystem access will be removed.'} Chats and session pins will be kept.`}
          confirmText="Delete folder"
          variant="destructive"
          onConfirm={async () => {
            try {
              if (deleting)
                await change({
                  command: { kind: 'delete-folder', folderId: deleting._id },
                })
              setDeleting(null)
            } catch (err) {
              toastError(err, 'Could not delete folder')
            }
          }}
        />
      </div>
      <DragOverlay dropAnimation={null}>
        {dragTitle && (
          <div className="bg-popover max-w-64 truncate rounded-md border px-3 py-2 text-sm shadow-lg">
            {dragTitle}
          </div>
        )}
      </DragOverlay>
    </DndContext>
  )
})

function SessionRenameDialog({
  id,
  onClose,
}: {
  id: string
  onClose: () => void
}) {
  const session = useSession(id)
  const updateSession = useMutation(api.sessions.update)
  const regenerateTitle = useAction(api.actions.sessions.regenerateTitle)

  return (
    <SessionTitleEditor
      show
      initialValue={session?.title}
      onClose={onClose}
      onConfirm={async (title) => {
        await updateSession({ sessionId: id as Id<'sessions'>, title })
        onClose()
      }}
      onRegenerate={() => regenerateTitle({ sessionId: id as Id<'sessions'> })}
    />
  )
}
