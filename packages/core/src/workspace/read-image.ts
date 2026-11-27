import { z } from 'zod'

export const FILE_IMAGE_MAX_BYTES = 512 * 1024

const dimension = z.number().int().positive()

export const fileImageMetadataSchema = z.object({
  kind: z.literal('image'),
  path: z.string(),
  mediaType: z.enum(['image/png', 'image/jpeg']),
  originalWidth: dimension,
  originalHeight: dimension,
  width: dimension,
  height: dimension,
})

export type FileImageMetadata = z.infer<typeof fileImageMetadataSchema>
export type FileImageOutput = FileImageMetadata & { base64: string }

export function isFileImageOutput(value: unknown): value is FileImageOutput {
  const output = value as Partial<FileImageOutput> | null
  return output?.kind === 'image' && typeof output.base64 === 'string'
}
