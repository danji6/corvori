import { api, internal } from '../../_generated/api'
import type { Id } from '../../_generated/dataModel'
import type { ActionCtx } from '../../_generated/server'
import { error } from '../../errors'
import { getSubject } from '../../functions'
import type { SessionProfileTarget } from '../../validators/sessionAuthors'
import { decodeBase64 } from '../io/base64'
import { postSidecar } from '../sidecar'
import { joinAvatarContentType } from './joinStorage'

const MAX_JOIN_AVATAR_BYTES = 2 * 1024 * 1024

type ThumbnailImageResult = {
  contentType: string
  data: string
}

type PngImageResult = {
  contentType: string
  data: string
}

export type AvatarUploadTarget =
  | { target: 'agent'; agentId: Id<'agents'>; file: Blob }
  | { target: 'profile'; file: Blob }
  | ({ target: 'session'; file: Blob; name?: string } & SessionProfileTarget)

type JoinWithAvatarArgs = { token: string; file: Blob; name?: string }

/** Processes an avatar only after checking the invite and the current member. */
export async function joinWithAvatar(
  ctx: ActionCtx,
  { token, file, name }: JoinWithAvatarArgs,
): Promise<{ sessionId: Id<'sessions'> }> {
  const subject = await getSubject(ctx)
  const invite = await ctx.runQuery(api.sessionShares.preview, { token })
  if (!invite) error('That invite token is invalid or has been revoked.', 404)
  if (invite.isMember) return { sessionId: invite.sessionId }

  // Canvas encoders that lack WebP support return PNG.
  const supportedType = file.type === 'image/webp' || file.type === 'image/png'
  if (!supportedType || !file.size || file.size > MAX_JOIN_AVATAR_BYTES)
    error('Choose a valid avatar image and try again.', 400)

  const stored: Id<'_storage'>[] = []
  try {
    const inputContentType =
      file.type === 'image/png'
        ? joinAvatarContentType.original
        : joinAvatarContentType.input
    const input = await ctx.storage.store(
      file.slice(0, file.size, inputContentType),
    )
    stored.push(input)
    const storageId = await generateAvatarPng(
      ctx,
      input,
      joinAvatarContentType.original,
    )
    stored.push(storageId)
    const thumbStorageId = await generateAvatarThumbnail(
      ctx,
      storageId,
      joinAvatarContentType.thumbnail,
    )
    stored.push(thumbStorageId)

    const sessionId = await ctx.runMutation(
      internal.sessionShares._redeemWithAvatar,
      {
        token,
        subject,
        profile: { name },
        storageId,
        thumbStorageId,
      },
    )
    if (!sessionId)
      error('That invite token is invalid or has been revoked.', 404)
    return { sessionId }
  } finally {
    if (stored.length > 0) {
      await ctx
        .runMutation(internal.avatars._discardJoinFiles, { ids: stored })
        .catch(() => {
          // The daily sweep retries cleanup for unreferenced files.
          console.warn('Could not clean up join avatar upload')
        })
    }
  }
}

export async function uploadAvatar(
  ctx: ActionCtx,
  args: AvatarUploadTarget,
): Promise<{ avatarId: Id<'avatars'> }> {
  const subject = args.target === 'session' ? await getSubject(ctx) : undefined

  if (args.target === 'session') {
    const editable = await ctx.runQuery(api.sessions.editableAuthorProfile, {
      sessionId: args.sessionId,
      sender: args.sender,
    })
    if (!editable) error('Forbidden', 403)
  }

  const uploadStorageId = await ctx.storage.store(args.file)
  let originalStorageId: Id<'_storage'> | undefined
  let thumbStorageId: Id<'_storage'> | undefined

  try {
    originalStorageId = await generateAvatarPng(ctx, uploadStorageId)
    await ctx.storage.delete(uploadStorageId).catch(() => {})

    thumbStorageId = await generateAvatarThumbnail(ctx, originalStorageId)

    if (args.target === 'session' && subject) {
      const avatarId = await ctx.runMutation(
        internal.sessions._confirmAuthorAvatar,
        {
          subject,
          sessionId: args.sessionId,
          sender: args.sender,
          name: args.name,
          originalStorageId,
          thumbStorageId,
        },
      )
      return { avatarId }
    }

    // The profile confirm creates the avatar record itself (and swaps out any
    // previous one), so we hand it the raw storage ids rather than pre-creating.
    if (args.target === 'profile') {
      const avatarId = await ctx.runMutation(api.users.confirmAvatarUpload, {
        originalStorageId,
        thumbStorageId,
      })
      return { avatarId }
    }

    if (args.target !== 'agent') error('Invalid avatar target', 400)
    const avatarId = await ctx.runMutation(internal.avatars._create, {
      storageId: originalStorageId,
      thumbStorageId,
    })
    await ctx.runMutation(api.agents.confirmAvatarUpload, {
      agentId: args.agentId,
      avatarId,
    })
    return { avatarId }
  } catch (err) {
    await ctx.storage.delete(uploadStorageId).catch(() => {})

    if (originalStorageId) {
      await ctx.storage.delete(originalStorageId).catch(() => {})
    }

    if (thumbStorageId) {
      await ctx.storage.delete(thumbStorageId).catch(() => {})
    }

    throw err
  }
}

async function generateAvatarPng(
  ctx: ActionCtx,
  uploadStorageId: Id<'_storage'>,
  contentType?: string,
): Promise<Id<'_storage'>> {
  const imageUrl = await ctx.storage.getUrl(uploadStorageId)
  if (!imageUrl) error('Avatar storage URL not found', 500)

  const image = await postSidecar<PngImageResult>('/io/image/png', { imageUrl })

  return ctx.storage.store(
    new Blob([decodeBase64(image.data)], {
      type: contentType ?? image.contentType,
    }),
  ) as Promise<Id<'_storage'>>
}

export async function generateAvatarThumbnail(
  ctx: ActionCtx,
  originalStorageId: Id<'_storage'>,
  contentType?: string,
): Promise<Id<'_storage'>> {
  const imageUrl = await ctx.storage.getUrl(originalStorageId)
  if (!imageUrl) error('Avatar storage URL not found', 500)

  const thumbnail = await postSidecar<ThumbnailImageResult>(
    '/io/image/thumbnail',
    { imageUrl },
  )

  return ctx.storage.store(
    new Blob([decodeBase64(thumbnail.data)], {
      type: contentType ?? thumbnail.contentType,
    }),
  ) as Promise<Id<'_storage'>>
}
