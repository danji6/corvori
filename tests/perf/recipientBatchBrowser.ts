import { api } from '@cv/convex/_generated/api'
import { APP_ID } from '@cv/core/const'
import { chromium, expect } from '@playwright/test'
import { strict as assert } from 'node:assert'

import { fixtureClient } from './clients'
import { type Deployment, withBrowserClient } from './deployment'
import type * as Batch from './recipientBatch'
import { type createMembers, send } from './recipientBatchLoad'
import type * as Fixture from './sharedSendsFixture'

type Member = Awaited<ReturnType<typeof createMembers>>[number]

export async function verifyNotificationNavigation(
  deployment: Deployment,
  [sender, recipient]: Member[],
  batched: boolean,
) {
  const fixture = fixtureClient<typeof Fixture>(
    deployment,
    'sharedSendsFixture',
  )
  const queue = fixtureClient<typeof Batch>(deployment, 'recipientBatch')
  const ids = { userIds: [sender.userId, recipient.userId] }
  const source = await fixture('_session', ids)
  const target = await fixture('_session', ids)
  const { userId: recipientId } = recipient
  await fixture('_inbox', {
    recipientId,
    sessionId: target,
    ordinary: 0,
    protectedCount: 1,
    resetCount: true,
  })
  await recipient.client.mutation(api.notifications.clearRead, {})
  return withBrowserClient(deployment, async (frontend) => {
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage({
        storageState: recipient.state,
        reducedMotion: 'reduce',
        viewport: { width: 1440, height: 900 },
      })
      await page.addInitScript((storageKey) => {
        localStorage.setItem(
          storageKey,
          JSON.stringify({
            sidebar: { left: { collapsed: false, pinned: true } },
          }),
        )
      }, `${APP_ID}-ui-settings:${recipient.userId}`)
      const actions: string[] = []
      page.on('websocket', (socket) =>
        socket.on('framesent', ({ payload }) => {
          const message = JSON.parse(payload.toString())
          if (message.type === 'Mutation')
            actions.push(message.udfPath + ':' + message.args[0]?.sessionId)
        }),
      )
      await page.goto(`${frontend}/?id=${source}`)
      await page.bringToFront()
      const badge = page
        .getByRole('button', { name: 'Notifications, 1 unread', exact: true })
        .first()
      await expect(badge).toBeVisible({ timeout: 20_000 })
      await expect
        .poll(() => actions.includes(`notifications:markSessionRead:${source}`))
        .toBe(true)
      const generation = batched
        ? await queue('_hold', { recipientId })
        : undefined
      const preview = 'Notification navigation probe'
      const id = await send(sender.client, source, preview)
      if (generation) {
        assert.equal((await queue('_queueState', { recipientId })).pending, 1)
      } else {
        await expect
          .poll(() =>
            actions.includes(`notifications:discardSession:${source}`),
          )
          .toBe(true)
        await expect(badge).toBeVisible()
        await expect
          .poll(async () => {
            const rows = await recipient.client.query(api.notifications.list, {
              status: 'unread',
            })
            return rows.some(({ sourceMessageId }) => sourceMessageId === id)
          })
          .toBe(false)
      }
      await page.evaluate(
        (sessionId) => history.pushState(null, '', `/?id=${sessionId}`),
        target,
      )
      await expect
        .poll(() => actions.includes(`notifications:markSessionRead:${target}`))
        .toBe(true)
      if (generation) {
        await expect
          .poll(
            async () => (await queue('_queueState', { recipientId })).pending,
          )
          .toBe(0)
      }

      const toast = page
        .locator('[data-sonner-toast]')
        .filter({ hasText: preview })
      let toastShown = false
      if (generation) {
        // Wait for either surface classification before checking durable inbox state.
        await expect
          .poll(async () => {
            toastShown = (await toast.count()) > 0
            return (
              toastShown ||
              actions.includes(`notifications:discardSession:${source}`)
            )
          })
          .toBe(true)
      } else {
        await expect(toast).toHaveCount(0)
      }
      const rows = await recipient.client.query(api.notifications.list, {
        status: 'unread',
      })
      return {
        toastShown,
        inUnreadInbox: rows.some(
          ({ sourceMessageId }) => sourceMessageId === id,
        ),
      }
    } finally {
      await browser.close()
    }
  })
}
