'use node'

import { internal } from '../../_generated/api'
import type { Id } from '../../_generated/dataModel'
import type { ActionCtx } from '../../_generated/server'
import { getSubject } from '../../functions'
import { decodeBase64, encodeBase64 } from '../io/base64'
import type { SessionArchive, SessionArchiveExportData } from './archive'
import { normalizeArchive } from './archiveAuthors'

export async function exportOne(
  ctx: ActionCtx,
  { sessionId }: { sessionId: Id<'sessions'> },
): Promise<SessionArchive> {
  const subject = await getSubject(ctx)
  const { archive, avatars }: SessionArchiveExportData = await ctx.runQuery(
    internal.sessions._exportOne,
    { sessionId, subject },
  )

  return {
    ...archive,
    avatars: await Promise.all(
      avatars.map(async (avatar) => {
        const blob = await ctx.storage.get(avatar.storageId)
        if (!blob) return null

        return {
          key: avatar.key,
          mediaType: blob.type.split(';', 1)[0] || 'image/png',
          data: encodeBase64(new Uint8Array(await blob.arrayBuffer())),
        }
      }),
    ).then((items) =>
      items.filter((item): item is NonNullable<typeof item> => item !== null),
    ),
  }
}

export async function importOne(
  ctx: ActionCtx,
  { payload }: { payload: SessionArchive },
): Promise<{ sessionId: Id<'sessions'> }> {
  const subject = await getSubject(ctx)
  const { authors } = normalizeArchive(payload)
  const referenced = new Set(authors.map(({ avatarKey }) => avatarKey))
  const incoming = new Map(
    (payload.avatars ?? []).map((avatar) => [avatar.key, avatar]),
  )
  const storageIds: Id<'_storage'>[] = []

  try {
    const entries: Array<[string, Id<'_storage'>]> = []
    for (const [key, avatar] of incoming) {
      if (!referenced.has(key)) continue
      const storageId = await ctx.storage.store(
        new Blob([decodeBase64(avatar.data)], { type: avatar.mediaType }),
      )
      storageIds.push(storageId)
      entries.push([key, storageId])
    }

    return await ctx.runMutation(internal.sessions._importOne, {
      payload,
      subject,
      avatars: Object.fromEntries(entries),
    })
  } catch (err) {
    await Promise.all(
      storageIds.map((storageId) =>
        ctx.storage.delete(storageId).catch(() => {}),
      ),
    )
    throw err
  }
}
