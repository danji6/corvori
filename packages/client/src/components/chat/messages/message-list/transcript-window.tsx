import type { RowTransition } from '@/lib/chat/row-expansion-state'
import type { MessageRow } from '@/lib/chat/rows'
import {
  createTranscriptVirtualizer,
  describeTranscriptRows,
} from '@/lib/chat/transcript-virtualizer'
import {
  type ComponentType,
  type ReactElement,
  type RefObject,
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react'
import { flushSync } from 'react-dom'
import type { CustomItemComponentProps, WindowVirtualizerHandle } from 'virtua'
import { UPDATE_SIZE_EVENT, UPDATE_VIRTUAL_STATE } from 'virtua/unstable_core'

import { MessageHighlightLayer } from '../message-highlight-context'
import { MessageBackgroundLayer } from './message-background-layer'
import { useMessageList } from './message-list-context'
import { MessageMenuHitArea, useNearbyMessageMenu } from './nearby-message-menu'

type ItemComponent = ComponentType<CustomItemComponentProps>

type TranscriptWindowProps = {
  ref: RefObject<WindowVirtualizerHandle | null>
  rows: readonly MessageRow[]
  editingRowIndex?: number
  showBackgrounds: boolean
  transitions: ReadonlyMap<string, RowTransition>
  shift: boolean
  item: ItemComponent
  renderRow: (row: MessageRow) => ReactElement
  onResize: () => void
}

/** Renders window-virtualized rows with keyed measurements for detail edits. */
export function TranscriptWindow({
  ref,
  rows,
  editingRowIndex = -1,
  showBackgrounds,
  transitions,
  shift,
  item,
  renderRow,
  onResize,
}: TranscriptWindowProps) {
  const root = useRef<HTMLDivElement>(null)
  const entries = useMemo(
    () => describeTranscriptRows(rows, transitions),
    [rows, transitions],
  )
  const [transcript] = useState(() => createTranscriptVirtualizer(entries))
  const { store, driver, layout } = transcript
  transcript.update(entries, shift)
  const [version, rerender] = useReducer(
    store.$getStateVersion,
    undefined,
    store.$getStateVersion,
  )
  const reportResize = useEffectEvent(onResize)
  const onRowsMeasured = useMessageList()?.onRowsMeasured
  const forwardNearbyMenu = useNearbyMessageMenu()
  const totalSize = store.$getTotalSize()

  useLayoutEffect(() => {
    store.$subscribe(UPDATE_VIRTUAL_STATE, (sync) => {
      if (sync) flushSync(rerender)
      else rerender()
    })
    store.$subscribe(UPDATE_SIZE_EVENT, () => reportResize())
    driver.$observe(root.current!)
    return () => {
      store.$dispose()
      driver.$dispose()
    }
  }, [driver, store])

  useLayoutEffect(() => {
    driver.$effect()
  }, [driver, version])

  useLayoutEffect(() => {
    onRowsMeasured?.()
  }, [onRowsMeasured, totalSize])

  useImperativeHandle(
    ref,
    () => ({
      get cache() {
        return layout.$snapshot()
      },
      get scrollOffset() {
        return store.$getScrollOffset()
      },
      get viewportSize() {
        return store.$getViewportSize()
      },
      findItemIndex: (offset) =>
        layout.$findIndex(offset - store.$getStartSpacerSize()),
      getItemOffset: store.$getItemOffset,
      getItemSize: layout.$getItemSize,
      scrollToIndex: driver.$scroll,
    }),
    [driver, layout, store],
  )

  const visibleIndices = transcript.visibleIndices(entries)
  const editingRowKey = rows[editingRowIndex]?.key
  const editOutsideRange =
    editingRowKey !== undefined && !visibleIndices.includes(editingRowIndex)
  const [mountedEditKey, setMountedEditKey] = useState<string>()
  const keepEditorMounted = editingRowKey === mountedEditKey
  // Let an offscreen edit scroll into range before the editor holds the layout.
  const nextMountedEditKey =
    editOutsideRange && !keepEditorMounted ? undefined : editingRowKey
  if (nextMountedEditKey !== mountedEditKey) {
    setMountedEditKey(nextMountedEditKey)
  }

  const revealEditor = useEffectEvent(() => {
    if (editOutsideRange) driver.$scroll(editingRowIndex, { align: 'nearest' })
  })
  useEffect(() => {
    if (editingRowKey) revealEditor()
  }, [editingRowKey])

  // Keep the editor DOM and its selection alive at its normal transcript offset.
  const renderedIndices =
    editOutsideRange && keepEditorMounted
      ? [...visibleIndices, editingRowIndex].sort((a, b) => a - b)
      : visibleIndices

  return (
    <div
      ref={root}
      data-slot="transcript-window"
      onContextMenu={forwardNearbyMenu}
      onMouseDown={forwardNearbyMenu}
      style={{
        contain: 'size style',
        overflowAnchor: 'none',
        flex: 'none',
        position: 'relative',
        width: '100%',
        height: totalSize,
        pointerEvents: store.$isScrolling() ? 'none' : undefined,
      }}
    >
      <MessageMenuHitArea />
      {showBackgrounds && (
        <MessageBackgroundLayer
          rows={rows}
          visibleIndices={visibleIndices}
          getOffset={store.$getItemOffset}
          getSize={layout.$getItemSize}
        />
      )}
      <MessageHighlightLayer root={root} rows={rows} layoutVersion={version} />
      {renderedIndices.map((index) => (
        <TranscriptItem
          key={rows[index]!.key}
          item={item}
          index={index}
          top={store.$getItemOffset(index)}
          hidden={layout.$isSizeEqual(index)}
          observe={driver.$observeItem}
        >
          {renderRow(rows[index]!)}
        </TranscriptItem>
      ))}
    </div>
  )
}

type TranscriptItemProps = {
  item: ItemComponent
  index: number
  top: number
  hidden: boolean
  observe: ReturnType<
    typeof createTranscriptVirtualizer
  >['driver']['$observeItem']
  children: ReactElement
}

function TranscriptItem({
  item: Item,
  index,
  top,
  hidden,
  observe,
  children,
}: TranscriptItemProps) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => observe(ref.current!, index), [observe, index])

  return (
    <Item
      ref={ref}
      index={index}
      style={{
        contain: 'layout style',
        position: 'absolute',
        width: '100%',
        left: 0,
        top,
        visibility: hidden ? 'hidden' : undefined,
      }}
    >
      {children}
    </Item>
  )
}
