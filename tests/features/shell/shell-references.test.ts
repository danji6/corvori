import type { Id } from '@cv/convex/_generated/dataModel'
import {
  bindReference,
  saveTerminal,
  transcriptReference,
} from '@cv/convex/model/shellReferences'
import { expect, test } from 'bun:test'
import { lifecycleDatabase } from '~/tests/helpers/lifecycle-db'

test('only chat members can resolve a child shell command and its saved terminal', async () => {
  const sessionId = 'chat' as Id<'sessions'>
  const messageId = 'command' as Id<'messages'>
  const jobId = 'shell-old-job'
  const command = {
    messageId,
    sessionId: 'child',
    version: 2,
    segmentIndex: 2,
    parts: [
      {
        type: 'tool-shell',
        toolCallId: 'start',
        input: { command: 'pwd' },
        output: { jobId, status: 'background', term: '' },
      },
    ],
  }
  const { ctx } = lifecycleDatabase({
    sessions: [{ _id: sessionId }, { _id: 'child', parent: { sessionId } }],
    messages: [{ _id: messageId, sessionId: 'child', selectedVersion: 2 }],
    messageContents: [
      { _id: 'command-old', ...command, version: 1, segmentIndex: 0 },
      { _id: 'command-current', ...command },
    ],
    userSessions: [{ _id: 'member', userId: 'viewer', sessionId }],
  })
  await bindReference(ctx, {
    sessionId,
    jobId,
    messageId,
    toolCallId: 'start',
    command: 'pwd',
  })
  await saveTerminal(ctx, sessionId, {
    jobId,
    status: 'done',
    exitCode: 0,
    text: 'saved output',
    term: 'saved output',
    termOffset: 5,
  })

  const args = { sessionId, jobId }
  expect(
    await transcriptReference(
      { ...(ctx as object), userId: 'viewer' } as never,
      args,
    ),
  ).toMatchObject({
    messageId: 'command',
    segmentIndex: 2,
    sessionId: 'child',
    toolCallId: 'start',
    number: 1,
    terminal: { jobId, status: 'done', term: 'saved output', termOffset: 5 },
  })
  expect(
    await transcriptReference(
      { ...(ctx as object), userId: 'outsider' } as never,
      args,
    ),
  ).toBeNull()
})
