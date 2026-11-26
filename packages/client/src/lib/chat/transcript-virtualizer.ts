import type { WindowVirtualizerHandle } from 'virtua'
import {
  ACTION_ITEMS_LENGTH_CHANGE,
  createListLayout,
  createVirtualStore,
  createWindowDriver,
} from 'virtua/unstable_core'

import type { RowTransition } from './row-expansion-state'
import type { MessageRow } from './rows'

type ItemRange = [start: number, end: number]
type ItemResize = readonly [index: number, size: number]

// Virtua's core entry point does not publish the internal layout types.
type ListLayout = {
  $getRange: (start: number, end: number) => ItemRange
  $findIndex: (offset: number) => number
  $getItemOffset: (index: number) => number
  $getItemSize: (index: number) => number
  $isSizeEqual: (index: number, size?: number) => boolean
  $setItemSizes: (sizes: readonly ItemResize[], viewportSize: number) => void
  $getTotalSize: () => number
  $getLength: () => number
  $setLength: (length: number, shift?: boolean) => void
  $isEstimating: () => boolean
  $snapshot: () => WindowVirtualizerHandle['cache']
}

type WindowStore = {
  $getStateVersion: () => number
  $getRange: (buffer: number) => ItemRange
  $getItemOffset: (index: number) => number
  $getScrollOffset: () => number
  $isScrolling: () => boolean
  $getViewportSize: () => number
  $getStartSpacerSize: () => number
  $getTotalSize: () => number
  $update: (action: number, length: number, shift: boolean) => void
  $subscribe: (event: number, callback: (sync?: boolean) => void) => () => void
  $dispose: () => void
}

type WindowDriver = {
  $observe: (container: HTMLElement) => void
  $observeItem: (element: HTMLElement, index: number) => () => void
  $scroll: WindowVirtualizerHandle['scrollToIndex']
  $effect: () => void
  $dispose: () => void
}

type LayoutRow = {
  key: string
  detail?: { index: number; phase?: RowTransition['phase'] }
}

// Virtua's snapshot uses -1 for items that fall back to the size estimate.
const UNMEASURED = -1
const BUFFER_PX = 200
const MIN_DETAIL_HEIGHT = 16

/** Describes work and note detail rows that can be inserted inside the list. */
export function describeTranscriptRows(
  rows: readonly MessageRow[],
  transitions: ReadonlyMap<string, RowTransition>,
): LayoutRow[] {
  const groupCounts = new Map<string, number>()
  return rows.map((row) => {
    const id = detailGroupId(row)
    if (!id) return { key: row.key }

    const index = groupCounts.get(id) ?? 0
    groupCounts.set(id, index + 1)
    return {
      key: row.key,
      detail: { index, phase: transitions.get(id)?.phase },
    }
  })
}

function detailGroupId(row: MessageRow) {
  if (row.kind === 'hidden') return row.noteGroupId
  if (row.kind === 'group' && !row.promotedToolCallIds) return row.workId
}

/** Keeps Virtua's window driver while remapping sizes for interior row edits. */
export function createTranscriptVirtualizer(initialRows: readonly LayoutRow[]) {
  const layout = createTranscriptLayout(initialRows)
  const store: WindowStore = createVirtualStore(layout)
  const driver: WindowDriver = createWindowDriver(store, layout, false)

  function update(rows: readonly LayoutRow[], shift: boolean) {
    if (layout.reconcile(rows, shift)) return
    store.$update(ACTION_ITEMS_LENGTH_CHANGE, rows.length, shift)
  }

  function visibleIndices(rows: readonly LayoutRow[]) {
    const [start, end] = store.$getRange(BUFFER_PX)
    const budget = store.$getViewportSize() + 2 * BUFFER_PX
    const detailLimit = Math.ceil(budget / MIN_DETAIL_HEIGHT)
    const indices: number[] = []
    for (let index = start; index <= end; index++) {
      const detail = rows[index]!.detail
      // Collapsed details share an offset. Only mount the portion that can
      // animate into the viewport and overscan before the group finishes opening.
      if (detail && isOpening(detail.phase) && detail.index >= detailLimit) {
        continue
      }
      indices.push(index)
    }
    return indices
  }

  return { layout, store, driver, update, visibleIndices }
}

function createTranscriptLayout(initialRows: readonly LayoutRow[]) {
  let rows = initialRows
  let layout: ListLayout = createListLayout(initialRows.length)

  function reconcile(next: readonly LayoutRow[], shift: boolean) {
    if (rows === next) return false
    const previous = rows
    rows = next
    if (shift || !needsReconciliation(previous, next)) return false

    const [sizes, estimate] = layout.$snapshot()
    const oldIndices = new Map(previous.map((row, index) => [row.key, index]))
    const nextSizes = next.map((row) => {
      const index = oldIndices.get(row.key)
      if (index === undefined) {
        return row.detail?.phase === 'preparing' ? 0 : UNMEASURED
      }

      const size = sizes[index]!
      // Give deferred details ordinary estimates as soon as they can mount.
      const finishedOpening = openingFinished(previous[index]!, row)
      return size === 0 && finishedOpening ? UNMEASURED : size
    })
    layout = rebuildLayout(nextSizes, estimate, layout.$isEstimating())
    return true
  }

  // The driver and store retain references to these methods across row updates.
  const liveLayout: ListLayout = {
    $getRange: (...args) => layout.$getRange(...args),
    $findIndex: (...args) => layout.$findIndex(...args),
    $getItemOffset: (...args) => layout.$getItemOffset(...args),
    $getItemSize: (...args) => layout.$getItemSize(...args),
    $isSizeEqual: (...args) => layout.$isSizeEqual(...args),
    $setItemSizes: (...args) => layout.$setItemSizes(...args),
    $getTotalSize: () => layout.$getTotalSize(),
    $getLength: () => layout.$getLength(),
    $setLength: (...args) => layout.$setLength(...args),
    $isEstimating: () => layout.$isEstimating(),
    $snapshot: () => layout.$snapshot(),
  }
  return { ...liveLayout, reconcile }
}

function rebuildLayout(
  sizes: number[],
  estimate: number | undefined,
  estimating: boolean,
): ListLayout {
  if (!estimating)
    return createListLayout(sizes.length, estimate, [sizes, estimate])

  // Retain the accumulated measurements while Virtua is still estimating.
  const layout: ListLayout = createListLayout(sizes.length, undefined, [
    [],
    estimate,
  ])
  const measured: ItemResize[] = []
  sizes.forEach((size, index) => {
    if (size !== UNMEASURED) measured.push([index, size])
  })
  layout.$setItemSizes(measured, 0)
  return layout
}

function isOpening(phase?: RowTransition['phase']) {
  return phase === 'preparing' || phase === 'opening'
}

function openingFinished(previous: LayoutRow, next: LayoutRow) {
  return isOpening(previous.detail?.phase) && !next.detail?.phase
}

function needsReconciliation(
  previous: readonly LayoutRow[],
  next: readonly LayoutRow[],
) {
  const [shorter, longer] =
    previous.length <= next.length ? [previous, next] : [next, previous]
  const sharedPrefix = shorter.every(
    (row, index) => row.key === longer[index]!.key,
  )
  // Reuse measurements by key when a row moves to a different index.
  if (!sharedPrefix) return true

  if (previous.length === next.length) {
    return previous.some((row, index) => openingFinished(row, next[index]!))
  }

  const isTransitioning = (row: LayoutRow) => !!row.detail?.phase
  return previous.some(isTransitioning) || next.some(isTransitioning)
}
