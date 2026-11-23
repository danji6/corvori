import { resolveWelcomeView } from '@/lib/chat/empty-chat'
import { create } from '@cv/convex/model/session/sessions'
import { expect, test } from 'bun:test'

import { lifecycleDatabase } from '../../helpers/lifecycle-db'

const ready = {
  providersLoaded: true,
  hasProviders: true,
  selectionLoaded: true,
  hasAgent: true,
  promptsLoaded: true,
  hasPrompts: false,
  folderLoaded: true,
}

test('provider setup overrides agent selection and configured prompts', () => {
  expect(
    resolveWelcomeView({ ...ready, hasProviders: false, hasPrompts: true }),
  ).toBe('providers')
  expect(
    resolveWelcomeView({ ...ready, hasProviders: false, hasAgent: false }),
  ).toBe('providers')
})

test('welcome waits for dependencies and preserves configured prompts', () => {
  for (const key of [
    'providersLoaded',
    'selectionLoaded',
    'promptsLoaded',
    'folderLoaded',
  ] as const) {
    expect(resolveWelcomeView({ ...ready, [key]: false })).toBe('loading')
  }
  expect(resolveWelcomeView({ ...ready, hasPrompts: true })).toBe('prompts')
  expect(resolveWelcomeView({ ...ready, hasAgent: false })).toBe('agents')
  expect(resolveWelcomeView(ready)).toBe('starters')
})

test('creates a usable owned session before any messages are sent', async () => {
  const { ctx, rows } = lifecycleDatabase({
    agents: [{ _id: 'agent', ownerId: 'owner' }],
  })
  const { sessionId } = await create(
    { ...(ctx as object), userId: 'owner' } as never,
    { activeAgentId: 'agent' as never },
  )
  expect(rows('sessions')[0]).toMatchObject({
    _id: sessionId,
    activeAgentId: 'agent',
  })
  expect(rows('userSessions')[0]).toMatchObject({
    sessionId,
    userId: 'owner',
    role: 'owner',
  })
  expect(rows('sessionAgents')[0]).toMatchObject({
    sessionId,
    agentId: 'agent',
  })
  expect(rows('messages')).toHaveLength(0)
  expect(rows('streams')).toHaveLength(0)
})
