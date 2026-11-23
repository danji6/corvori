import type * as RecentDirectoryStore from '@/lib/chat/recent-directory-store'
import { uiSettingsStore } from '@/lib/ui-settings'
import { APP_ID } from '@cv/core/const'
import { afterEach, beforeAll, expect, test } from 'bun:test'
import { setupDom } from '~/tests/setup/dom'

setupDom()

const STORAGE_KEY = `${APP_ID}-ui-settings:owner`
let store: typeof RecentDirectoryStore

beforeAll(async () => {
  store = await import('@/lib/chat/recent-directory-store')
})

afterEach(() => {
  localStorage.removeItem(STORAGE_KEY)
})

test('recent selections are unique, newest first, and bounded', () => {
  for (let index = 0; index < 12; index++) {
    store.rememberDirectory('owner', `/projects/${index}`)
  }
  store.rememberDirectory('owner', '/projects/5')

  const expected = [5, 11, 10, 9, 8, 7, 6, 4, 3, 2].map(
    (index) => `/projects/${index}`,
  )
  expect(store.getRecentDirectories('owner')).toEqual(expected)
  expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual({
    recentDirectories: expected,
  })
})

test('confirmed selections notify subscribers immediately', () => {
  let notifications = 0
  const unsubscribe = uiSettingsStore('owner').subscribe(() => notifications++)
  store.rememberDirectory('owner', '/other')

  expect(store.getRecentDirectories('owner')[0]).toBe('/other')
  expect(notifications).toBe(1)
  unsubscribe()
})
