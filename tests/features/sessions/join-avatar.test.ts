import type { Id } from '@cv/convex/_generated/dataModel'
import type { AuthMutationCtx } from '@cv/convex/functions'
import { joinWithAvatar } from '@cv/convex/model/avatars/actions'
import {
  discardJoinAvatarFiles,
  joinAvatarContentType,
  sweepJoinAvatarFiles,
} from '@cv/convex/model/avatars/joinStorage'
import { preview, redeemInvite } from '@cv/convex/model/session/shares'
import * as sidecar from '@cv/convex/model/sidecar'
import { expect, spyOn, test } from 'bun:test'
import { type FunctionReference, getFunctionName } from 'convex/server'

import { lifecycleDatabase } from '../../helpers/lifecycle-db'

type Stored = { _id: string; _creationTime: number; contentType: string }
type Commit = Parameters<typeof redeemInvite>[2]

async function fixture() {
  const token = 'invite'
  const tokenHash = new Bun.CryptoHasher('sha256').update(token).digest('hex')
  const database = lifecycleDatabase({
    sessions: [{ _id: 'session', ownerId: 'owner' }],
    sessionShares: [{ _id: 'share', sessionId: 'session', tokenHash }],
  })
  const base = database.ctx as AuthMutationCtx
  const files = new Map<string, Stored>()
  const db = {
    ...base.db,
    system: {
      get: async (_table: string, id: string) => files.get(id) ?? null,
      query: () => ({
        paginate: async () => ({ page: [...files.values()], isDone: true }),
      }),
    },
  } as unknown as AuthMutationCtx['db']
  const mutationCtx = {
    ...base,
    userId: 'member',
    db,
    storage: { delete: async (id: string) => void files.delete(id) },
  } as AuthMutationCtx

  let sequence = 0
  const storage = {
    store: async (blob: Blob) => {
      const _id = `file-${++sequence}`
      files.set(_id, { _id, _creationTime: Date.now(), contentType: blob.type })
      return _id
    },
    getUrl: async (id: string) => `https://example.test/${id}`,
  }
  const actionCtx = {
    auth: { getUserIdentity: async () => ({ subject: 'member' }) },
    storage,
    runQuery: (_reference: unknown, args: { token: string }) =>
      preview(mutationCtx, args),
    async runMutation(reference: FunctionReference<'mutation'>, args: unknown) {
      if (getFunctionName(reference) === 'avatars:_discardJoinFiles')
        return discardJoinAvatarFiles(
          mutationCtx,
          args as Parameters<typeof discardJoinAvatarFiles>[1],
        )
      const { storageId, thumbStorageId, ...redeemArgs } =
        args as NonNullable<Commit> & Parameters<typeof redeemInvite>[1]
      return redeemInvite(mutationCtx, redeemArgs, {
        storageId,
        thumbStorageId,
      })
    },
  }
  const input = {
    token,
    file: new Blob(['av'], { type: 'image/webp' }),
    name: 'Alex',
  }
  return { actionCtx, mutationCtx, files, input, database }
}

test('an invalid invite skips avatar processing and an image failure discards its files', async () => {
  const { actionCtx, files, input, database } = await fixture()
  const image = spyOn(sidecar, 'postSidecar').mockRejectedValue(
    new Error('Invalid image'),
  )
  try {
    await expect(
      joinWithAvatar(actionCtx as never, { ...input, token: 'wrong' }),
    ).rejects.toThrow('invalid')
    expect(image).not.toHaveBeenCalled()
    await expect(joinWithAvatar(actionCtx as never, input)).rejects.toThrow(
      'Invalid image',
    )
    expect(files.size).toBe(0)
    expect(database.rows('userSessions')).toHaveLength(0)
  } finally {
    image.mockRestore()
  }
})

test('revocation during image processing leaves no membership, notice, or stored files', async () => {
  const { actionCtx, files, input, database } = await fixture()
  const image = spyOn(sidecar, 'postSidecar').mockImplementation(async () => {
    database.rows('sessionShares')[0]!.revokedAt = Date.now()
    return { data: 'AAAA' } as never
  })
  try {
    await expect(joinWithAvatar(actionCtx as never, input)).rejects.toThrow(
      'revoked',
    )
    expect(files.size).toBe(0)
    expect(database.rows('userSessions')).toHaveLength(0)
    expect(database.rows('messages')).toHaveLength(0)
  } finally {
    image.mockRestore()
  }
})

test('a retry after a lost commit response keeps the first profile and avatar', async () => {
  const { actionCtx, mutationCtx, files, input, database } = await fixture()
  const image = spyOn(sidecar, 'postSidecar').mockResolvedValue({
    data: 'AAAA',
  })
  try {
    const lostResponse = {
      ...actionCtx,
      async runMutation(
        reference: FunctionReference<'mutation'>,
        args: unknown,
      ) {
        const value = await actionCtx.runMutation(reference, args)
        if (getFunctionName(reference) === 'sessionShares:_redeemWithAvatar')
          throw new Error('Connection lost after commit')
        return value
      },
    }
    await expect(joinWithAvatar(lostResponse as never, input)).rejects.toThrow(
      'Connection lost',
    )
    await expect(
      joinWithAvatar(actionCtx as never, { ...input, name: 'Other' }),
    ).resolves.toEqual({ sessionId: 'session' as Id<'sessions'> })
    expect(image).toHaveBeenCalledTimes(2)
    expect(database.rows('messages')).toHaveLength(1)
    const [profile] = database.rows('sessionProfiles')
    expect(profile?.name).toBe('Alex')
    expect(profile?.avatarId).toBe(database.rows('avatars')[0]?._id)
    expect(files.size).toBe(2)

    const cutoff = Date.now() + 1
    files.set('abandoned', {
      _id: 'abandoned',
      _creationTime: cutoff,
      contentType: joinAvatarContentType.original,
    })
    files.set('unrelated', {
      _id: 'unrelated',
      _creationTime: cutoff,
      contentType: 'image/png',
    })
    files.set('recent', {
      _id: 'recent',
      _creationTime: cutoff + 1,
      contentType: joinAvatarContentType.input,
    })
    await sweepJoinAvatarFiles(mutationCtx, { cutoff })
    expect([...files.keys()]).toEqual([
      'file-2',
      'file-3',
      'unrelated',
      'recent',
    ])
  } finally {
    image.mockRestore()
  }
})
