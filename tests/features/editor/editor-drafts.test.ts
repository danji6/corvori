/// <reference types="bun-types" />
import {
  SCRIPTS_DRAFT_KEY,
  USER_SETTINGS_DRAFT_KEY,
  agentSettingsDraftKey,
  clearEditorDraft,
  getEditorDraft,
  planDraftKey,
  promptDraftKey,
  reminderDraftKey,
  setEditorDraft,
} from '@/lib/chat/editor-draft-store'
import { APP_ID } from '@cv/core/const'
import { beforeEach, describe, expect, test } from 'bun:test'
import { setupDom } from '~/tests/setup/dom'

setupDom()

/** Mirrors the store's own cap; exceeding it must evict the oldest entries. */
const MAX_ENTRIES = 50
const STORAGE_KEY = `${APP_ID}-editor-drafts:owner`

type PromptDraft = { name: string; content?: string }

function keysInStorage(): string[] {
  const raw = localStorage.getItem(STORAGE_KEY)
  return raw ? Object.keys(JSON.parse(raw)) : []
}

beforeEach(() => {
  for (const key of keysInStorage()) clearEditorDraft('owner', key)
})

describe('draft keys', () => {
  test('namespace prompts, reminders and scripts apart', () => {
    expect(promptDraftKey('abc')).toBe('prompt:abc')
    expect(reminderDraftKey('abc')).toBe('reminder:abc')
    expect(SCRIPTS_DRAFT_KEY).toBe('scripts')
    expect(promptDraftKey('abc')).not.toBe(reminderDraftKey('abc'))
  })

  test('give each session its own plan draft', () => {
    expect(planDraftKey('s1')).toBe('plan:s1')
    expect(planDraftKey('s1')).not.toBe(planDraftKey('s2'))
    expect(planDraftKey('x')).not.toBe(promptDraftKey('x'))
  })

  test('give each agent its own settings draft', () => {
    expect(agentSettingsDraftKey('a1')).toBe('agent-settings:a1')
    expect(agentSettingsDraftKey('a1')).not.toBe(agentSettingsDraftKey('a2'))
    expect(USER_SETTINGS_DRAFT_KEY).toBe('user-settings')
  })

  test('never collide a settings form with an editor on the same id', () => {
    // A prompt editor and a settings form can be open at once, each holding a
    // different slice of the same unsaved work.
    expect(agentSettingsDraftKey('x')).not.toBe(promptDraftKey('x'))
    expect(agentSettingsDraftKey('x')).not.toBe(reminderDraftKey('x'))
  })
})

describe('settings form drafts', () => {
  test('round-trip a form draft with an unapplied prompt', () => {
    // The case that motivated form drafting: a prompt that was added but never
    // applied exists nowhere but the form.
    const values = {
      name: 'Agent',
      prompts: [{ id: 'p-new', name: 'Added', content: 'Typed.' }],
    }
    setEditorDraft('owner', agentSettingsDraftKey('a1'), values)

    expect(
      getEditorDraft<typeof values>('owner', agentSettingsDraftKey('a1')),
    ).toEqual(values)
  })

  test('keep each agent draft independent', () => {
    setEditorDraft('owner', agentSettingsDraftKey('a1'), { name: 'One' })
    setEditorDraft('owner', agentSettingsDraftKey('a2'), { name: 'Two' })
    clearEditorDraft('owner', agentSettingsDraftKey('a1'))

    expect(getEditorDraft('owner', agentSettingsDraftKey('a1'))).toBeUndefined()
    expect(
      getEditorDraft<{ name: string }>('owner', agentSettingsDraftKey('a2')),
    ).toEqual({ name: 'Two' })
  })
})

describe('get/set/clear', () => {
  test('round-trips an arbitrary draft value', () => {
    const draft: PromptDraft = { name: 'Rewrite', content: '# hello' }
    setEditorDraft('owner', promptDraftKey('p1'), draft)
    expect(getEditorDraft<PromptDraft>('owner', promptDraftKey('p1'))).toEqual(
      draft,
    )
  })

  test('returns undefined for an unknown key', () => {
    expect(getEditorDraft('owner', promptDraftKey('missing'))).toBeUndefined()
  })

  test('overwrites rather than merging', () => {
    setEditorDraft('owner', promptDraftKey('p1'), { name: 'a', content: 'x' })
    setEditorDraft('owner', promptDraftKey('p1'), { name: 'b' })
    expect(getEditorDraft<PromptDraft>('owner', promptDraftKey('p1'))).toEqual({
      name: 'b',
    })
  })

  test('clear removes only its own key', () => {
    setEditorDraft('owner', promptDraftKey('p1'), { name: 'a' })
    setEditorDraft('owner', promptDraftKey('p2'), { name: 'b' })
    clearEditorDraft('owner', promptDraftKey('p1'))

    expect(getEditorDraft('owner', promptDraftKey('p1'))).toBeUndefined()
    expect(getEditorDraft<PromptDraft>('owner', promptDraftKey('p2'))).toEqual({
      name: 'b',
    })
  })

  test('clearing an absent key does not write', () => {
    setEditorDraft('owner', promptDraftKey('p1'), { name: 'a' })
    const before = localStorage.getItem(STORAGE_KEY)
    clearEditorDraft('owner', promptDraftKey('never-stored'))
    expect(localStorage.getItem(STORAGE_KEY)).toBe(before)
  })

  test('survives a reload, which is the point of the feature', () => {
    setEditorDraft('owner', SCRIPTS_DRAFT_KEY, {
      scripts: [{ id: 's1', code: 'x' }],
    })
    const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY)!)
    expect(persisted[SCRIPTS_DRAFT_KEY].value).toEqual({
      scripts: [{ id: 's1', code: 'x' }],
    })
  })
})

describe('eviction', () => {
  test('keeps the cap and drops the least recently touched', () => {
    for (let index = 0; index < MAX_ENTRIES; index++) {
      setEditorDraft('owner', promptDraftKey(`p${index}`), {
        name: `n${index}`,
      })
    }
    expect(keysInStorage()).toHaveLength(MAX_ENTRIES)

    setEditorDraft('owner', promptDraftKey('newest'), { name: 'newest' })

    expect(keysInStorage()).toHaveLength(MAX_ENTRIES)
    expect(
      getEditorDraft<PromptDraft>('owner', promptDraftKey('newest')),
    ).toEqual({
      name: 'newest',
    })
    expect(getEditorDraft('owner', promptDraftKey('p0'))).toBeUndefined()
    expect(
      getEditorDraft<PromptDraft>(
        'owner',
        promptDraftKey(`p${MAX_ENTRIES - 1}`),
      ),
    ).toEqual({
      name: `n${MAX_ENTRIES - 1}`,
    })
  })
})
