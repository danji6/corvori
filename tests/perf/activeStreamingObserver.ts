import { api } from '@cv/convex/_generated/api'
import {
  MESSAGE_PAGE_BUDGET_BYTES,
  MESSAGE_WINDOW_MAX_ROWS,
} from '@cv/core/const'
import { ConvexClient, ConvexHttpClient } from 'convex/browser'
import { makeFunctionReference } from 'convex/server'
import { strict as assert } from 'node:assert'

import { type Script, now } from './activeStreamingProvider'
import { type Account, type SessionId, deadline } from './clients'
import type { Deployment } from './deployment'

type Update = { at: number; text: string }

function textOf(parts: unknown[]) {
  return parts
    .flatMap((part) => {
      if (!part || typeof part !== 'object') return []
      if (!('type' in part) || part.type !== 'text') return []
      return 'text' in part && typeof part.text === 'string' ? [part.text] : []
    })
    .join('')
}

export function observeTurn(
  deployment: Deployment,
  account: Account,
  sessionId: SessionId,
  script: Script,
) {
  const args = {
    sessionId,
    anchor: null,
    direction: 'older' as const,
    limit: MESSAGE_WINDOW_MAX_ROWS,
    budgetBytes: MESSAGE_PAGE_BUDGET_BYTES,
  }
  const http = new ConvexHttpClient(deployment.url, {
    auth: account.token,
    logger: false,
  })
  const client = new ConvexClient(deployment.url, {
    unsavedChangesWarning: false,
    logger: false,
  })
  client.setAuth(({ forceRefreshToken }) =>
    forceRefreshToken ? account.refreshToken() : Promise.resolve(account.token),
  )

  const windowReady = Promise.withResolvers<void>()
  const tailReady = Promise.withResolvers<void>()
  const first = Promise.withResolvers<number>()
  const final = Promise.withResolvers<Update>()
  const failure = Promise.withResolvers<never>()
  void failure.promise.catch(() => {})
  const updates: Update[] = []

  function observe(text: string, done = false) {
    const at = now()
    if (text && text !== updates.at(-1)?.text) {
      updates.push({ at, text })
      if (text.trim()) first.resolve(at)
    }
    if (done) final.resolve({ at, text })
  }

  const offWindow = client.onUpdate(
    api.chat.messagesWindow,
    args,
    ({ page }) => {
      windowReady.resolve()
      const message = page.find((row) => row.role === 'assistant')
      if (message?.status === 'done') {
        observe(
          textOf(message.segments.flatMap((segment) => segment.parts)),
          true,
        )
      }
    },
    failure.reject,
  )
  const offTail = client.onUpdate(
    api.chat.processingMessageSegments,
    { sessionId },
    (rows) => {
      tailReady.resolve()
      if (rows[0]) observe(textOf(rows[0].segment.parts))
    },
    failure.reject,
  )

  function wait<T>(promise: Promise<T>, label: string) {
    return deadline(
      Promise.race([promise, failure.promise]),
      `${label} for ${script.marker}`,
      30_000,
    )
  }

  return {
    ready: () =>
      wait(
        Promise.all([windowReady.promise, tailReady.promise]),
        'message subscriptions',
      ),
    first: () => wait(first.promise, 'first assistant text'),
    final: () => wait(final.promise, 'final assistant message'),
    updates,
    persistedText: () => http.query(stopText, { sessionId }),
    async send() {
      const started = now()
      await http.mutation(api.chat.sendMessage, {
        sessionId,
        content: `Write the numbered script for ${script.marker}`,
      })
      return started
    },
    async stop() {
      const at = now()
      await http.mutation(api.chat.stopStream, { sessionId })
      const acknowledgedAt = now()
      // The window and mutable tail are read at the same committed snapshot.
      const text = await http.query(stopText, { sessionId })
      return { at, acknowledgedAt, text }
    },
    async close() {
      offWindow()
      offTail()
      await client.close()
    },
  }
}

const stopText = makeFunctionReference<
  'query',
  { sessionId: SessionId },
  string
>('activeStreamingFixture:stopText')

export function verifyText(
  script: Script,
  updates: Update[],
  final: string,
  stopped: boolean,
) {
  const emitted = script.chunks.map(({ text }) => text).join('')
  let previous = ''
  for (const { text } of updates) {
    assert.ok(emitted.startsWith(text), `Unexpected text for ${script.marker}`)
    assert.ok(
      text.startsWith(previous),
      `Output regressed for ${script.marker}`,
    )
    previous = text
  }
  if (!stopped)
    assert.equal(final, emitted, `Incomplete output for ${script.marker}`)
}
