import { Collapsible } from '@/components/ui/collapsible'
import {
  RootSessionFoldersQuery,
  type SessionGroupPage,
  SessionGroupPreload,
  SessionGroupQuery,
} from '@/hooks/chat/sessions'
import { useSidebarStreaming } from '@/hooks/chat/sidebar-streaming'
import { isFolderCollapsed } from '@/lib/chat/session-folder-state'
import {
  type GroupRow,
  type SessionTreeNode,
  nestSessionRows,
} from '@/lib/chat/session-groups'
import { type ReactNode, useMemo, useState } from 'react'

import { FolderBranchContent } from './folder-branch-content'
import { RecentsSection } from './recents-section'
import { SessionPage, type SessionRowRenderer } from './session-page'

type SessionTreeProps = {
  rows: GroupRow[]
  collapsed: Record<string, boolean>
  renderRow: SessionRowRenderer
  search: string
  pages: Record<string, SessionGroupPage>
  dragging: boolean
  streamingEnabled?: boolean
  organizationPending?: boolean
}

/** Animates and unloads each folder's contents as one branch. */
export function SessionTree({
  rows,
  collapsed,
  renderRow,
  search,
  pages,
  dragging,
  streamingEnabled = true,
  organizationPending = false,
}: SessionTreeProps) {
  const [recentsOpen, setRecentsOpen] = useState(true)
  const nodes = useMemo(() => nestSessionRows(rows), [rows])
  useSidebarStreaming(nodes, collapsed, recentsOpen, streamingEnabled)

  function renderBranch(
    node: SessionTreeNode,
    ancestorOpen = true,
    parentKey = 'folders',
  ): ReactNode {
    const { row, children } = node
    const open = !isFolderCollapsed(collapsed, row.key, row.folderAncestorIds)
    const branchOpen = open && ancestorOpen
    const header = open
      ? row
      : {
          ...row,
          last: true,
          endingFolderIds: node.endingFolderIds,
        }

    const childBranches = children.filter(
      (child) => child.row.kind === 'header',
    )

    return (
      <Collapsible
        key={row.key}
        open={open}
        data-session-folder={row.key}
        data-page-entry={parentKey}
      >
        {renderRow(header)}
        {ancestorOpen && <SessionGroupPreload groupKey={row.key} />}
        <FolderBranchContent
          open={open}
          disabled={dragging || !ancestorOpen}
          ready={Boolean(
            pages[row.key] && pages[row.key]?.status !== 'LoadingFirstPage',
          )}
        >
          <SessionGroupQuery groupKey={row.key} />
          <SessionPage
            groupKey={row.key}
            rows={children
              .filter((child) => child.row.kind !== 'header')
              .map((child) => child.row)}
            page={pages[row.key]}
            disabled={dragging || !branchOpen}
            renderRow={renderRow}
            branchIds={childBranches.map((child) => child.row.key)}
            animate={false}
          >
            {childBranches.map((child) =>
              renderBranch(child, branchOpen, row.key),
            )}
          </SessionPage>
        </FolderBranchContent>
      </Collapsible>
    )
  }

  if (search.trim()) {
    return (
      <div key="search">
        <SessionGroupQuery groupKey="search" search={search} />
        <SessionPage
          key={search}
          groupKey="search"
          rows={rows}
          page={pages.search}
          disabled={dragging}
          renderRow={renderRow}
        />
      </div>
    )
  }

  const folderPage = pages.folders
  const showFolderFooter =
    folderPage?.showLess ||
    folderPage?.status === 'CanLoadMore' ||
    folderPage?.status === 'LoadingMore'
  const recents = nodes.find((node) => node.row.key === 'recents')
  const folderBranches = nodes.filter((node) => node !== recents)

  return (
    <div key="browse">
      <RootSessionFoldersQuery />
      <SessionPage
        groupKey="folders"
        rows={showFolderFooter ? [{ kind: 'footer', key: 'folders' }] : []}
        page={folderPage}
        disabled={dragging}
        renderRow={renderRow}
        branchIds={folderBranches.map(({ row }) => row.key)}
      >
        {folderBranches.map((node) => renderBranch(node))}
      </SessionPage>
      <RecentsSection
        open={recentsOpen}
        onOpenChange={setRecentsOpen}
        pending={organizationPending}
      >
        <SessionPage
          groupKey="recents"
          rows={recents?.children.map((node) => node.row) ?? []}
          page={pages.recents}
          disabled={dragging || !recentsOpen}
          renderRow={renderRow}
        />
      </RecentsSection>
    </div>
  )
}
