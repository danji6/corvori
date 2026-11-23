import type { Id } from '@cv/convex/_generated/dataModel'
import type { ActionCtx } from '@cv/convex/_generated/server'
import { editMessage } from '@cv/convex/model/chat/mutations'
import { sendMessage } from '@cv/convex/model/chat/send'
import { runPromptEvaluation } from '@cv/convex/model/promptEvaluation/runner'
import {
  finishEvaluation,
  pinInstance,
  readInput,
  readState,
} from '@cv/convex/model/promptEvaluation/state'
import { patchState } from '@cv/convex/model/session/state'
import { buildEvalContext } from '@cv/convex/model/stream/evalContext'
import { evaluateRequest } from '@cv/core/interpreter/request'
import { expect, spyOn, test } from 'bun:test'
import { getFunctionName } from 'convex/server'
import { skillsDatabase } from '~/tests/helpers/skills-db'

const sessionId = 'session' as Id<'sessions'>
const owner = 'owner' as Id<'users'>
const script = '#eval\nreturn shell("printf", "literal text")\n#end'

function fixture(role: 'admin' | 'user' = 'admin', workspace = true) {
  const f = skillsDatabase()
  f.rows('sessions').push({
    _id: sessionId,
    ownerId: owner,
    folderId: workspace ? 'folder' : undefined,
  })
  f.rows('users').push({ _id: owner, role })
  f.rows('userSessions').push({ _id: 'member', sessionId, userId: owner })
  f.rows('sessionFolders').push({
    _id: 'folder',
    ownerId: owner,
    name: 'Repo',
    sources: [{ path: '/workspace', label: 'Repo' }],
  })
  f.rows('settings').push({ _id: 'settings', ownerId: owner, shell: '/bin/sh' })

  const action = {
    runQuery: (ref: never, args: never) =>
      getFunctionName(ref) === 'promptEvaluations:_input'
        ? readInput(f.ctx, args)
        : readState(f.ctx, args),
    runMutation: (ref: never, args: never) =>
      getFunctionName(ref) === 'promptEvaluations:_pin'
        ? pinInstance(f.ctx, args)
        : finishEvaluation(f.ctx, args),
  } as unknown as ActionCtx
  return { ...f, action }
}

test('an admin send without an agent captures shell output once and preserves attachments and variables', async () => {
  const f = fixture()
  f.rows('attachments').push({
    _id: 'attachment',
    sessionId,
    uploaderId: owner,
    filename: 'note.txt',
    mediaType: 'text/plain',
  })
  const messageId = await sendMessage(f.ctx, {
    sessionId,
    content: script.replace('return shell', "setVar('count', 2)\nreturn shell"),
    attachments: [{ id: 'attachment' as Id<'attachments'> }],
    silent: true,
  })
  const row = f
    .rows('messageContents')
    .find((row) => row.messageId === messageId)!
  const id = row.promptEvaluationId as Id<'promptEvaluations'>
  const literalOutput = '#eval\nreturn 42\n#end'
  const shell = spyOn(
    { execute: (..._args: string[]) => literalOutput },
    'execute',
  )
  let reply: Awaited<ReturnType<typeof evaluateRequest>> | undefined

  const fetch = spyOn(globalThis, 'fetch').mockImplementation((async (
    url,
    init,
  ) => {
    if (String(url).endsWith('/instance'))
      return Response.json({ bootId: 'sidecar' })
    const { input, grant } = JSON.parse(String(init?.body))
    if (input) {
      expect(input.context).toMatchObject({ tools: [], isAdmin: true })
      expect(input.context.assistant).toBeUndefined()
      expect(input.shell).toMatchObject({
        shell: '/bin/sh',
        workspace: { path: '/workspace' },
      })
      reply = await evaluateRequest({ ...input, authored: true }, { shell })
      await patchState(f.ctx, sessionId, { environment: { unrelated: true } })
      return Response.json({ state: 'running', call: 1 })
    }
    if (String(url).endsWith('/status')) {
      expect(grant).toEqual({ call: 1, allowed: true })
      return Response.json({ state: 'complete', result: reply })
    }
    return Response.json({ ok: true })
  }) as typeof globalThis.fetch)

  try {
    expect(
      await runPromptEvaluation(f.action, id, { deadline: Date.now() + 5000 }),
    ).toBe('settled')
    expect(
      await runPromptEvaluation(f.action, id, { deadline: Date.now() + 5000 }),
    ).toBe('settled')
    expect(shell).toHaveBeenCalledTimes(1)
    expect(shell).toHaveBeenCalledWith('printf', 'literal text')
    expect(row.parts).toEqual([
      expect.objectContaining({ type: 'file', attachmentId: 'attachment' }),
      { type: 'text', text: literalOutput, evaluationRendered: true },
    ])
    expect(f.rows('sessionState')[0].environment).toEqual({
      count: 2,
      unrelated: true,
    })
  } finally {
    fetch.mockRestore()
    shell.mockRestore()
  }
})

test('role changes and edits revoke shell access and the previous result cannot publish', async () => {
  const f = fixture()
  const messageId = await sendMessage(f.ctx, {
    sessionId,
    content: script,
    silent: true,
  })
  const row = f.rows('messageContents')[0]
  const id = row.promptEvaluationId as Id<'promptEvaluations'>
  expect((await readState(f.ctx, { id }))?.allowed).toBe(true)
  await f.db.patch(owner, { role: 'user' })
  expect((await readState(f.ctx, { id }))?.allowed).toBe(false)
  await f.db.patch(owner, { role: 'admin' })

  await editMessage(f.ctx, { messageId, content: script })
  const edited = row.promptEvaluationId as Id<'promptEvaluations'>
  expect(edited).not.toBe(id)
  expect((await readState(f.ctx, { id: edited }))?.allowed).toBe(false)
  expect(await finishEvaluation(f.ctx, { id, parts: [] })).toBe(false)
  expect(row.parts).toEqual([
    { type: 'text', text: 'Evaluating prompt…', evaluationPending: true },
  ])
})

test('fresh evaluation uses session names and inherits each global name on reset', async () => {
  const f = fixture('user', false)
  const agentId = 'agent' as Id<'agents'>
  f.rows('agents').push({ _id: agentId, ownerId: owner, name: 'Global agent' })
  await f.db.patch(sessionId, { activeAgentId: agentId })
  await f.db.patch('settings', { displayName: 'Global user' })
  f.rows('sessionProfiles').push(
    {
      _id: 'user-profile',
      sessionId,
      sender: { type: 'user', id: owner },
      name: 'Session user',
    },
    {
      _id: 'agent-profile',
      sessionId,
      sender: { type: 'agent', id: agentId },
      name: 'Session agent',
    },
  )
  await sendMessage(f.ctx, {
    sessionId,
    content: '{{user}} and {{assistant}}',
    silent: true,
  })
  const id = f.rows('messageContents')[0]
    .promptEvaluationId as Id<'promptEvaluations'>
  const context = async () =>
    buildEvalContext({ ...(await readInput(f.ctx, { id }))!, toolNames: [] })

  expect(await context()).toMatchObject({
    user: 'Session user',
    assistant: 'Session agent',
  })
  await f.db.patch('user-profile', { name: undefined })
  await f.db.patch('agent-profile', { name: undefined })
  expect(await context()).toMatchObject({
    user: 'Global user',
    assistant: 'Global agent',
  })
})

test('a non-admin send still evaluates scripts with the normal shell denial', async () => {
  const f = fixture('user', false)
  await sendMessage(f.ctx, { sessionId, content: script, silent: true })
  const id = f.rows('messageContents')[0]
    .promptEvaluationId as Id<'promptEvaluations'>
  expect((await readState(f.ctx, { id }))?.allowed).toBe(false)

  const fetch = spyOn(globalThis, 'fetch').mockImplementation((async (
    url,
    init,
  ) => {
    if (String(url).endsWith('/instance'))
      return Response.json({ bootId: 'sidecar' })
    if (String(url).endsWith('/acknowledge')) return Response.json({ ok: true })
    const { input } = JSON.parse(String(init?.body))
    expect(input.shell).toBeUndefined()
    const result = await evaluateRequest({ ...input, authored: true })
    return Response.json({ state: 'complete', result })
  }) as typeof globalThis.fetch)

  try {
    expect(
      await runPromptEvaluation(f.action, id, { deadline: Date.now() + 5000 }),
    ).toBe('settled')
    expect(f.rows('messageContents')[0].parts).toEqual([
      { type: 'text', text: 'Not an admin', evaluationRendered: true },
    ])
  } finally {
    fetch.mockRestore()
  }
})
