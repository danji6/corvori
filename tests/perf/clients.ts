import { api } from '@cv/convex/_generated/api'
import type { Id } from '@cv/convex/_generated/dataModel'
import { type APIRequestContext, request } from '@playwright/test'
import { ConvexClient, ConvexHttpClient } from 'convex/browser'
import {
  type DefaultFunctionArgs,
  type RegisteredMutation,
  makeFunctionReference,
} from 'convex/server'
import { setTimeout as sleep } from 'node:timers/promises'

import type { Deployment } from './deployment'
import type * as Fixture from './sidebarFixture'

export type SessionId = Id<'sessions'>

export function deadline<T>(promise: Promise<T>, label: string, ms = 12_000) {
  return Promise.race([
    promise,
    sleep(ms, undefined, { ref: false }).then(() => {
      throw new Error(`Timed out waiting for ${label}`)
    }),
  ])
}

export async function signUp(
  context: APIRequestContext,
  deployment: Deployment,
  index: number,
) {
  const username = `perf_viewer_${index}`
  const response = await context.post(
    `${deployment.site}/api/auth/sign-up/email`,
    {
      data: {
        username,
        name: username,
        email: `${username}@corvori.local`,
        password: crypto.randomUUID(),
      },
    },
  )
  if (!response.ok())
    throw new Error(
      `Creating test account ${index} failed (${response.status()}): ${await response.text()}`,
    )
  const issued = await context.get(`${deployment.site}/api/auth/convex/token`)
  if (!issued.ok())
    throw new Error(`Issuing test account token failed (${issued.status()})`)
  const { token } = (await issued.json()) as { token: string }
  const client = new ConvexHttpClient(deployment.url, {
    auth: token,
    logger: false,
  })
  await client.mutation(api.users.ensureProfile, {})
  const profile = await client.query(api.users.getProfile, {})
  if (!profile) throw new Error('Test account profile was not initialized')
  const state = await context.storageState()
  return {
    token,
    userId: profile._id,
    refreshToken: async () => {
      const refreshed = await context.get(
        `${deployment.site}/api/auth/convex/token`,
      )
      if (!refreshed.ok())
        throw new Error('Could not refresh test account token')
      return ((await refreshed.json()) as { token: string }).token
    },
    state,
  }
}

export type Account = Awaited<ReturnType<typeof signUp>>

export async function withAccounts(
  deployment: Deployment,
  count: number,
  execute: (accounts: Account[]) => Promise<void>,
) {
  const contexts = await Promise.all(
    Array.from({ length: count }, () => request.newContext()),
  )
  try {
    const accounts = []
    // Initialize the first admin before concurrently creating regular users.
    accounts.push(await signUp(contexts[0], deployment, 0))
    for (let i = 1; i < contexts.length; i += 4) {
      const group = contexts.slice(i, i + 4)
      accounts.push(
        ...(await Promise.all(
          group.map((context, offset) =>
            signUp(context, deployment, i + offset),
          ),
        )),
      )
    }
    await execute(accounts)
  } finally {
    await Promise.all(contexts.map((context) => context.dispose()))
  }
}

type FixtureMutation<Fixtures> = {
  [K in keyof Fixtures]: Fixtures[K] extends { isMutation: true } ? K : never
}[keyof Fixtures]
type FixtureArgs<Fixtures, K extends FixtureMutation<Fixtures>> =
  Fixtures[K] extends RegisteredMutation<
    'internal',
    infer Args extends DefaultFunctionArgs,
    unknown
  >
    ? Args & DefaultFunctionArgs
    : never
type FixtureResult<Fixtures, K extends FixtureMutation<Fixtures>> =
  Fixtures[K] extends RegisteredMutation<
    'internal',
    DefaultFunctionArgs,
    infer Result
  >
    ? Awaited<Result>
    : never

export function adminClient(deployment: Deployment) {
  const client = new ConvexHttpClient(deployment.url, { logger: false })
  const admin = client as ConvexHttpClient & { setAdminAuth(key: string): void }
  admin.setAdminAuth(deployment.key)
  return client
}

export function fixtureClient<Fixtures = typeof Fixture>(
  deployment: Deployment,
  module = 'sidebarFixture',
) {
  const client = adminClient(deployment)
  return <K extends FixtureMutation<Fixtures>>(
    name: K,
    args: FixtureArgs<Fixtures, K>,
  ) => {
    const mutation = makeFunctionReference<
      'mutation',
      DefaultFunctionArgs,
      FixtureResult<Fixtures, K>
    >(`${module}:${String(name)}`)
    return client.mutation(mutation, args)
  }
}

const baseline = makeFunctionReference<
  'query',
  Record<string, never>,
  SessionId[]
>('sidebarFixture:baseline')

export function observe(
  deployment: Deployment,
  account: Account,
  ids: SessionId[],
  mode: 'baseline' | 'scoped' = 'scoped',
) {
  const client = new ConvexClient(deployment.url, {
    unsavedChangesWarning: false,
    logger: false,
  })
  client.setAuth(({ forceRefreshToken }) =>
    forceRefreshToken ? account.refreshToken() : Promise.resolve(account.token),
  )
  let current: SessionId[] | undefined
  let failure: Error | undefined
  const listeners = new Set<() => void>()
  const onUpdate = (value: SessionId[]) => {
    current = value
    listeners.forEach((notify) => notify())
  }
  const onError = (error: Error) => {
    failure = error
    listeners.forEach((notify) => notify())
  }
  if (mode === 'baseline') client.onUpdate(baseline, {}, onUpdate, onError)
  else
    client.onUpdate(
      api.streams.activeSessionIdsForSessions,
      { sessionIds: ids },
      onUpdate,
      onError,
    )

  async function waitFor(check: (ids: SessionId[]) => boolean) {
    let notify: () => void
    const pending = new Promise<SessionId[]>((resolve, reject) => {
      notify = () => {
        if (failure) reject(failure)
        else if (current && check(current)) resolve(current)
      }
      notify()
      listeners.add(notify)
    })
    try {
      return await deadline(pending, 'sidebar subscription')
    } finally {
      listeners.delete(notify!)
    }
  }

  return { waitFor, close: () => client.close() }
}

export function observeInbox(
  deployment: Deployment,
  account: Account,
  summary = false,
) {
  const client = new ConvexClient(deployment.url, {
    unsavedChangesWarning: false,
    logger: false,
  })
  client.setAuth(() => account.refreshToken())
  const received = new Map<Id<'messages'>, number>()
  const visible = new Set<Id<'messages'>>()
  let failure: Error | undefined
  let notify: () => void
  const ready = new Promise<void>((resolve, reject) => {
    client.onUpdate(
      api.notifications.list,
      { status: 'unread' },
      (rows) => {
        const now = performance.now()
        visible.clear()
        for (const row of rows) {
          const id = row.sourceMessageId
          if (!id) continue
          visible.add(id)
          if (!received.has(id)) received.set(id, now)
        }
        resolve()
        notify?.()
      },
      (error) => {
        failure = error
        reject(error)
        notify?.()
      },
    )
  })
  const summaryReady = summary
    ? new Promise<void>((resolve, reject) => {
        client.onUpdate(
          api.notifications.summary,
          {},
          () => resolve(),
          (error) => {
            failure = error
            reject(error)
            notify?.()
          },
        )
      })
    : Promise.resolve()
  function waitFor(predicate: () => boolean, label: string, timeout?: number) {
    return deadline(
      new Promise<void>((resolve, reject) => {
        notify = () => {
          if (failure) reject(failure)
          else if (predicate()) resolve()
        }
        notify()
      }),
      label,
      timeout,
    )
  }
  async function delivery(ids: Id<'messages'>[], timeout?: number) {
    await waitFor(
      () => ids.every((id) => received.has(id)),
      'notification delivery',
      timeout,
    )
    return ids.map((id) => received.get(id)!)
  }
  const cleared = (ids: Id<'messages'>[]) =>
    waitFor(() => ids.every((id) => !visible.has(id)), 'inbox reset')
  return {
    ready: Promise.all([ready, summaryReady]),
    delivery,
    cleared,
    receipt: (id: Id<'messages'>) => received.get(id),
    close: () => client.close(),
  }
}
