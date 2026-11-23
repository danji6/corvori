import {
  getCreatedAgentId,
  getEditingAgentId,
  isNewAgent,
  setCreatedAgentId,
  setEditingAgentId,
  startNewAgent,
} from '@/lib/chat/agent-editor-store'
import {
  NEW_AGENT_DRAFT_KEY,
  agentSettingsDraftKey,
  clearEditorDraft,
  getEditorDraft,
  setEditorDraft,
} from '@/lib/chat/editor-draft-store'
import { APP_ID } from '@cv/core/const'
import { afterEach, expect, test } from 'bun:test'
import { setupDom } from '~/tests/setup/dom'

setupDom()

afterEach(() => {
  setEditingAgentId('owner', null)
  clearEditorDraft('owner', NEW_AGENT_DRAFT_KEY)
})

test('new agent selection and edits persist separately from database IDs', () => {
  setEditingAgentId('owner', 'existing')
  startNewAgent('owner')
  setEditorDraft('owner', NEW_AGENT_DRAFT_KEY, { name: 'Writer', prompts: [] })

  expect(isNewAgent('owner')).toBe(true)
  expect(getEditingAgentId('owner')).toBeNull()
  expect(NEW_AGENT_DRAFT_KEY).not.toBe(agentSettingsDraftKey('existing'))
  expect(
    JSON.parse(localStorage.getItem(`${APP_ID}-ui-settings:owner`)!)
      .agentEditor,
  ).toEqual({ newAgent: true })
  expect(
    JSON.parse(localStorage.getItem(`${APP_ID}-editor-drafts:owner`)!)[
      NEW_AGENT_DRAFT_KEY
    ].value.name,
  ).toBe('Writer')
})

test('a partially completed Save retains its ID for retries', () => {
  startNewAgent('owner')
  setCreatedAgentId('owner', 'created')
  expect(isNewAgent('owner')).toBe(true)
  expect(getCreatedAgentId('owner')).toBe('created')
  expect(
    JSON.parse(localStorage.getItem(`${APP_ID}-ui-settings:owner`)!)
      .agentEditor,
  ).toEqual({ newAgent: true, createdAgentId: 'created' })

  setEditingAgentId('owner', 'created')
  expect(isNewAgent('owner')).toBe(false)
  expect(getCreatedAgentId('owner')).toBeUndefined()
  expect(getEditingAgentId('owner')).toBe('created')
})

test('discarding a draft removes its values and leaves existing agents alone', () => {
  startNewAgent('owner')
  setEditorDraft('owner', NEW_AGENT_DRAFT_KEY, { name: 'Discard me' })
  clearEditorDraft('owner', NEW_AGENT_DRAFT_KEY)
  setEditingAgentId('owner', 'existing')
  expect(getEditorDraft('owner', NEW_AGENT_DRAFT_KEY)).toBeUndefined()
  expect(getEditingAgentId('owner')).toBe('existing')
})
