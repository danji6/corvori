'use node'

import { internal } from '../../_generated/api'
import type { ActionCtx } from '../../_generated/server'
import type {
  LinkPreviewJob,
  PublishLinkPreviewArgs,
} from '../../validators/linkPreviews'
import { loadLinkPreview } from './preview'

const CONCURRENT_PREVIEWS = 4

export async function loadSavedLinkPreviews(
  ctx: ActionCtx,
  job: LinkPreviewJob,
) {
  while (true) {
    const pending = await ctx.runQuery(internal.chat._readLinkPreviewWork, job)
    if (!pending.length) return
    const results = await Promise.allSettled(
      pending
        .slice(0, CONCURRENT_PREVIEWS)
        .map((url) => fetchAndPublish(ctx, job, url)),
    )
    const failure = results.find((result) => result.status === 'rejected')
    if (failure) throw failure.reason
  }
}

async function fetchAndPublish(
  ctx: ActionCtx,
  job: LinkPreviewJob,
  url: string,
) {
  const preview = await fetchPreview(ctx, url)
  try {
    await ctx.runMutation(internal.chat._publishLinkPreview, {
      ...job,
      url,
      preview,
    })
  } catch (error) {
    if (preview?.imageStorageId) {
      await ctx.storage.delete(preview.imageStorageId).catch(() => {})
    }
    throw error
  }
}

async function fetchPreview(
  ctx: ActionCtx,
  url: string,
): Promise<PublishLinkPreviewArgs['preview']> {
  const result = await loadLinkPreview(url)
  if (!result) return null
  const { image, ...preview } = result
  const imageStorageId =
    image && (await ctx.storage.store(image).catch(() => undefined))
  return imageStorageId ? { ...preview, imageStorageId } : preview
}
