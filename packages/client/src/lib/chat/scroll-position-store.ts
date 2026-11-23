import { APP_ID } from '@cv/core/const'

import { createAccountLocalStorage } from '../local-storage-store'
import { boundedEntryPatch } from './bounded-entries'
import type { ScrollRowAddress } from './scroll-address'

const STORAGE_KEY = `${APP_ID}-scroll-positions`

/** How many sessions retain a saved scroll position before the oldest is evicted. */
const MAX_ENTRIES = 100

export type SavedScroll = {
  anchorId: string
  creationTime: number
  segmentIndex?: number
  /** Stable key of the exact row, for sub-message alignment. */
  rowKey?: string
  rowAddress?: ScrollRowAddress
  /** Measures the body node rather than the virtualized row's spacing. */
  contentOffset?: boolean
  /** Offset (px) of the anchor's top from the nav-padding line. */
  offset: number
  /** Whether the user was pinned to the bottom when they left. */
  following: boolean
  /** Last touched timestamp, for LRU eviction. */
  updatedAt: number
}

type ScrollPositions = Record<string, SavedScroll>

const store = createAccountLocalStorage<ScrollPositions>(STORAGE_KEY)

export function getSavedScroll(
  userId: string,
  sessionId: string,
): SavedScroll | undefined {
  return store(userId).get()[sessionId]
}

export function setSavedScroll(
  userId: string,
  sessionId: string,
  position: Omit<SavedScroll, 'updatedAt'>,
): void {
  const entry: SavedScroll = { ...position, updatedAt: Date.now() }
  store(userId).update((current) =>
    boundedEntryPatch(current, sessionId, entry, MAX_ENTRIES),
  )
}

export function clearSavedScroll(userId: string, sessionId: string): void {
  store(userId).set({ [sessionId]: undefined } as Partial<ScrollPositions>)
}
