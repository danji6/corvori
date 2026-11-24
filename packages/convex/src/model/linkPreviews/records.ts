import { linkPreviewUrls } from '@cv/core/utils/markdown-links'

import { internal } from '../../_generated/api'
import type { Doc, Id } from '../../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../../_generated/server'
import type {
  LinkPreviewJob,
  LinkPreviewRecord,
  PublishLinkPreviewArgs,
  TranscriptLinkPreview,
} from '../../validators/linkPreviews'
import {
  isEvaluationPlaceholder,
  isTextPart,
  isUnevaluatedTextPart,
} from '../messages'

type Content = Pick<
  Doc<'messageContents'>,
  '_id' | 'linkPreviews' | 'linkPreviewGeneration'
>

const MAX_SEGMENT_LINKS = 16
const MAX_URL_BYTES = 2_048
const encoder = new TextEncoder()

export function canGenerateLinkPreviews(
  message: Pick<Doc<'messages'>, 'hidden' | 'type' | 'status'>,
) {
  return (
    message.status === 'done' && !message.hidden && message.type !== 'summary'
  )
}

function segmentUrls(parts: unknown[]) {
  const urls = new Set<string>()
  for (const part of parts) {
    if (!isTextPart(part) || !/https?:\/\//i.test(part.text)) continue
    const text = part.text
    if (isEvaluationPlaceholder(part) || isUnevaluatedTextPart(part)) continue
    for (const url of linkPreviewUrls(text)) {
      if (encoder.encode(url).length > MAX_URL_BYTES) continue
      urls.add(url)
      if (urls.size === MAX_SEGMENT_LINKS) return [...urls]
    }
  }
  return [...urls]
}

/** Preserves results by URL and queues new lookups in the content transaction. */
export async function reconcileLinkPreviews(
  ctx: MutationCtx,
  row: Content,
  parts: unknown[],
  merged: readonly Content[] = [],
) {
  const previous = row.linkPreviews ?? []
  const urls = segmentUrls(parts)
  if (!urls.length && !previous.length && !merged.length) return

  const candidates = mergeSavedPreviews(previous, merged)
  const generation = (row.linkPreviewGeneration ?? 0) + 1
  const next = urls.map<LinkPreviewRecord>(
    (url) => candidates.get(url) ?? { url, state: 'pending', generation },
  )
  const queued = next.some((entry) => isPending(entry, generation))
  if (queued) {
    await ctx.scheduler.runAfter(
      0,
      internal.actions.messages._loadLinkPreviews,
      {
        contentId: row._id,
        generation,
      },
    )
  }
  if (
    previous.length !== next.length ||
    next.some((entry, i) => entry !== previous[i])
  ) {
    await ctx.db.patch(row._id, {
      linkPreviews: next.length ? next : undefined,
      ...(queued && { linkPreviewGeneration: generation }),
    })
  }
  for (const source of [row, ...merged]) {
    await deleteLinkPreviewImages(ctx, source, next)
  }
}

function mergeSavedPreviews(
  previous: LinkPreviewRecord[],
  merged: readonly Content[],
) {
  const byUrl = new Map(previous.map((entry) => [entry.url, entry]))
  for (const row of merged) {
    for (const entry of row.linkPreviews ?? []) {
      if (entry.state === 'pending') continue
      const existing = byUrl.get(entry.url)
      if (
        !existing ||
        (entry.state === 'ready' && existing.state !== 'ready')
      ) {
        byUrl.set(entry.url, entry)
      }
    }
  }
  return byUrl
}

/** Releases images owned by the segment, except those moved into merged content. */
export async function deleteLinkPreviewImages(
  ctx: MutationCtx,
  row: Content,
  retained: LinkPreviewRecord[] = [],
) {
  for (const entry of row.linkPreviews ?? []) {
    if (entry.state !== 'ready' || !entry.imageStorageId) continue
    if (!hasImage(retained, entry.imageStorageId)) {
      await ctx.storage.delete(entry.imageStorageId)
    }
  }
}

function hasImage(entries: LinkPreviewRecord[], id: Id<'_storage'>) {
  return entries.some(
    (entry) => entry.state === 'ready' && entry.imageStorageId === id,
  )
}

function isPending(entry: LinkPreviewRecord, generation: number) {
  return entry.state === 'pending' && entry.generation === generation
}

export async function readLinkPreviewWork(ctx: QueryCtx, job: LinkPreviewJob) {
  const row = await ctx.db.get(job.contentId)
  if (!row?.linkPreviews) return []

  const pending = row.linkPreviews.filter((entry) =>
    isPending(entry, job.generation),
  )
  if (!pending.length) return []

  const urls = new Set(segmentUrls(row.parts))

  return pending
    .filter((entry) => urls.has(entry.url))
    .map((entry) => entry.url)
}

export async function publishLinkPreview(
  ctx: MutationCtx,
  args: PublishLinkPreviewArgs,
) {
  const { contentId, generation, preview, url } = args
  const row = await ctx.db.get(contentId)
  const entries = row?.linkPreviews ?? []
  const index = entries.findIndex(
    (entry) => entry.url === url && isPending(entry, generation),
  )

  if (!row || index === -1 || !segmentUrls(row.parts).includes(url)) {
    const id = preview?.imageStorageId
    if (id && !hasImage(entries, id)) await ctx.storage.delete(id)
    return
  }

  const next = [...entries]
  next[index] = preview
    ? { url, state: 'ready', ...preview }
    : { url, state: 'unavailable' }

  await ctx.db.patch(contentId, { linkPreviews: next })
}

export async function transcriptLinkPreviews(
  ctx: QueryCtx,
  records: LinkPreviewRecord[] | undefined,
): Promise<TranscriptLinkPreview[] | undefined> {
  const ready = records?.filter((entry) => entry.state === 'ready')
  if (!ready?.length) return undefined
  return Promise.all(
    ready.map(async (entry) => {
      const { state: _state, imageStorageId, ...preview } = entry
      const image = imageStorageId && (await ctx.storage.getUrl(imageStorageId))
      return image ? { ...preview, image } : preview
    }),
  )
}
