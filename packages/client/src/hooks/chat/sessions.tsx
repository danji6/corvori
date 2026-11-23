import { useActiveSessionId } from '@/hooks/chat/session'
import { createUsableContext } from '@/hooks/context'
import type { SessionListItem } from '@/lib/chat'
import type { PaginationMetadata } from '@/lib/chat/message-store'
import { type SessionStore, createSessionStore } from '@/lib/chat/session-store'
import { api } from '@cv/convex/_generated/api'
import type { FolderView } from '@cv/convex/model/session/types'
import { parseSessionSearch } from '@cv/core/session-search/parse'
import { usePaginatedQuery } from 'convex-helpers/react/cache/hooks'
import {
  type ReactNode,
  useCallback,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react'

import { useFolderPage } from './folder-page'
import {
  FOLDER_PAGE_SIZE,
  PAGE_STEP,
  RECENTS_PAGE_SIZE,
  usePaginationWindow,
} from './pagination-window'
import { useSessionDrops } from './session-drops'
import { useSessionSearchPage } from './session-search-page'

const [SessionStoreContext, useSessionStore] =
  createUsableContext<SessionStore>('SessionStore')

const [SessionSearchContext, useSessionSearch] =
  createUsableContext<(query: string) => void>('SessionSearch')

interface ShowHiddenControls {
  showHidden: boolean
  setShowHidden: (value: boolean) => void
}

const [SessionShowHiddenContext, useSessionShowHidden] =
  createUsableContext<ShowHiddenControls>('SessionShowHidden')

export { useSessionSearch, useSessionShowHidden }

export type SessionGroupPage = {
  results: SessionListItem[]
  folders?: FolderView[]
  sessionsDeferred?: boolean
  status: PaginationMetadata['status']
  loadMore: (count: number) => void
  showLess?: () => void
  shrinkCount?: number
}

const [SessionGroupsContext, useSessionGroups] = createUsableContext<{
  pages: Record<string, SessionGroupPage>
  search: string
  folders: FolderView[]
  pendingSessionIds: Set<string>
  dropSession: (item: SessionListItem, target: string) => Promise<void>
}>('SessionGroups')

export { useSessionGroups }

type PublishPage = (key: string, page: SessionGroupPage | null) => void

const [SessionPagesContext, usePublishSessionPage] =
  createUsableContext<PublishPage>('SessionPages')

/** Retains metadata identity when only a group's session rows change. */
function useLoadedFolders(pages: Record<string, SessionGroupPage>) {
  const [previous, setPrevious] = useState<FolderView[]>([])
  const folders = [
    ...new Map(
      Object.values(pages)
        .flatMap((page) => page.folders ?? [])
        .map((folder) => [folder._id, folder]),
    ).values(),
  ]
  const changed =
    folders.length !== previous.length ||
    folders.some((folder, index) => folder !== previous[index])
  if (!changed) return previous
  setPrevious(folders)
  return folders
}

export function SessionStoreProvider({ children }: { children: ReactNode }) {
  const [store] = useState(createSessionStore)
  const [search, setSearch] = useState('')
  const [showHidden, setShowHidden] = useState(false)
  const [serverPages, setPages] = useState<Record<string, SessionGroupPage>>({})
  const folders = useLoadedFolders(serverPages)
  const { pages, pendingSessionIds, dropSession } = useSessionDrops(serverPages, folders) // prettier-ignore
  const activeId = useActiveSessionId()
  const publish = useCallback((key: string, page: SessionGroupPage | null) => {
    setPages((current) => {
      const next = { ...current }
      if (page) next[key] = page
      else delete next[key]
      return next
    })
  }, [])

  useLayoutEffect(() => {
    const sessionsById = new Map<string, SessionListItem>()
    for (const [key, page] of Object.entries(pages)) {
      if (key === 'recents') continue
      for (const item of page.results) sessionsById.set(item._id, item)
    }
    // Folder pages can retain a snapshot while more rows load.
    for (const item of pages.recents?.results ?? []) {
      sessionsById.set(item._id, item)
    }
    store.sync({
      results: [...sessionsById.values()],
      loadMore: () => {},
      status: 'Exhausted',
      activeId,
    })
  }, [store, pages, activeId])

  return (
    <SessionStoreContext.Provider value={store}>
      <SessionSearchContext.Provider value={setSearch}>
        <SessionShowHiddenContext.Provider
          value={{ showHidden, setShowHidden }}
        >
          <SessionGroupsContext.Provider
            value={{ pages, search, folders, pendingSessionIds, dropSession }}
          >
            <SessionPagesContext.Provider value={publish}>
              {children}
            </SessionPagesContext.Provider>
          </SessionGroupsContext.Provider>
        </SessionShowHiddenContext.Provider>
      </SessionSearchContext.Provider>
    </SessionStoreContext.Provider>
  )
}

/** Keeps a visible folder's initial page ready without publishing hidden rows. */
export function SessionGroupPreload({ groupKey }: { groupKey: string }) {
  const { showHidden } = useSessionShowHidden()
  useFolderPage({ groupKey, search: '', showHidden })
  return null
}

const EMPTY_SESSIONS: SessionListItem[] = []

/** Publishes top-level folders independently of Recents and its visibility filter. */
export function RootSessionFoldersQuery() {
  const {
    results: folders,
    status,
    loadMore,
  } = usePaginatedQuery(
    api.sessionFolders.page,
    { groupKey: 'ungrouped' },
    { initialNumItems: FOLDER_PAGE_SIZE },
  )
  const page = useSessionPageWindow(
    { results: EMPTY_SESSIONS, status, loadMore, folders },
    FOLDER_PAGE_SIZE,
  )
  usePublishGroupPage('folders', page)
  return null
}

/** Loads a group's display pages only while its contents are mounted. */
export function SessionGroupQuery({
  groupKey,
  search = '',
}: {
  groupKey: string
  search?: string
}) {
  const { showHidden } = useSessionShowHidden()
  const query = search.trim()
  return (
    <SessionGroupLoader
      key={JSON.stringify([groupKey, query, showHidden])}
      groupKey={groupKey}
      search={query}
      showHidden={showHidden}
    />
  )
}

type SessionGroupLoaderProps = {
  groupKey: string
  search: string
  showHidden: boolean
}

function SessionGroupLoader({
  groupKey,
  search,
  showHidden,
}: SessionGroupLoaderProps) {
  const candidates = useFolderPage({ groupKey, search, showHidden })
  const hasFilters = parseSessionSearch(search).clauses.length > 0
  const matches = useSessionSearchPage(candidates, hasFilters)
  const initialSize =
    groupKey === 'search'
      ? PAGE_STEP
      : groupKey === 'recents'
        ? RECENTS_PAGE_SIZE
        : FOLDER_PAGE_SIZE
  const page = useSessionPageWindow(
    {
      ...matches,
      folders: candidates.folders,
      sessionsDeferred: candidates.sessionsDeferred,
    },
    initialSize,
  )
  usePublishGroupPage(groupKey, page)
  return null
}

function useSessionPageWindow(page: SessionGroupPage, initialSize: number) {
  const { folders, results, status, loadMore } = page
  const folderCount = folders?.length ?? 0
  const {
    visible,
    status: windowStatus,
    showMore,
    showLess,
    shrinkCount,
  } = usePaginationWindow({
    initialSize,
    loaded: folderCount + results.length,
    status,
    loadMore,
  })
  const sessionCount = Math.max(0, visible - folderCount)

  return {
    results: useMemo(
      () =>
        results.length <= sessionCount
          ? results
          : results.slice(0, sessionCount),
      [results, sessionCount],
    ),
    folders: useMemo(
      () => (folderCount <= visible ? folders : folders?.slice(0, visible)),
      [folders, folderCount, visible],
    ),
    status: windowStatus,
    loadMore: showMore,
    showLess,
    shrinkCount,
    sessionsDeferred:
      page.sessionsDeferred || (visible <= folderCount && folderCount > 0),
  }
}

function usePublishGroupPage(groupKey: string, page: SessionGroupPage) {
  const publish = usePublishSessionPage()
  const {
    results,
    status,
    loadMore,
    showLess,
    shrinkCount,
    folders,
    sessionsDeferred,
  } = page

  useLayoutEffect(() => {
    publish(groupKey, {
      results,
      status,
      loadMore,
      showLess,
      shrinkCount,
      folders,
      sessionsDeferred,
    })
  }, [
    groupKey,
    results,
    status,
    loadMore,
    showLess,
    shrinkCount,
    folders,
    sessionsDeferred,
    publish,
  ])
  useLayoutEffect(() => () => publish(groupKey, null), [groupKey, publish])
}

export function useSessionIds(): string[] {
  const store = useSessionStore()
  return useSyncExternalStore(store.subscribe, store.getIds)
}

export function useSession(id: string): SessionListItem | null {
  const store = useSessionStore()
  return useSyncExternalStore(store.subscribe, () => store.getSession(id))
}

export function useSessionIsActive(id: string): boolean {
  const store = useSessionStore()
  return useSyncExternalStore(store.subscribe, () => store.getIsActive(id))
}

export function useSessionIsStreaming(id: string): boolean {
  const store = useSessionStore()
  return useSyncExternalStore(store.subscribe, () => store.getIsStreaming(id))
}

export function useSetSidebarStreamingIds() {
  return useSessionStore().setStreamingIds
}

export function useSessionPagination(): PaginationMetadata & {
  loadMore: (numItems: number) => void
} {
  const store = useSessionStore()
  const meta = useSyncExternalStore(
    store.subscribe,
    store.getPaginationMetadata,
  )
  return { ...meta, loadMore: store.loadMore }
}
