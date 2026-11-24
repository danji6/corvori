import { type Infer, v } from 'convex/values'

const linkPreviewKind = v.union(
  v.literal('website'),
  v.literal('image'),
  v.literal('video'),
  v.literal('audio'),
)

const previewMetadata = v.object({
  kind: linkPreviewKind,
  title: v.string(),
  description: v.optional(v.string()),
})

const resultFields = {
  ...previewMetadata.fields,
  imageStorageId: v.optional(v.id('_storage')),
}

export const linkPreviewRecord = v.union(
  v.object({
    url: v.string(),
    state: v.literal('pending'),
    generation: v.number(),
  }),
  v.object({ url: v.string(), state: v.literal('unavailable') }),
  v.object({ url: v.string(), state: v.literal('ready'), ...resultFields }),
)

export type LinkPreviewRecord = Infer<typeof linkPreviewRecord>

export type LinkPreviewMetadata = Infer<typeof previewMetadata>

export type TranscriptLinkPreview = LinkPreviewMetadata & {
  url: string
  image?: string
}

export const linkPreviewJobArgs = v.object({
  contentId: v.id('messageContents'),
  generation: v.number(),
})

export type LinkPreviewJob = Infer<typeof linkPreviewJobArgs>

export const publishLinkPreviewArgs = linkPreviewJobArgs.extend({
  url: v.string(),
  preview: v.union(v.null(), v.object(resultFields)),
})

export type PublishLinkPreviewArgs = Infer<typeof publishLinkPreviewArgs>
