import type { JSONValue } from '@ai-sdk/provider'
import { READ_FILE_TOOL_NAME } from '@cv/core/const'
import {
  FILE_IMAGE_MAX_BYTES,
  fileImageMetadataSchema,
  isFileImageOutput,
} from '@cv/core/workspace/read-image'
import type { ContentBlock } from '@modelcontextprotocol/sdk/types.js'
import type { Tool, ToolSet } from 'ai'

import { ToolError } from '../../errors'

type ModelOutput = Awaited<ReturnType<NonNullable<Tool['toModelOutput']>>>

export function readFileOutput(text: string, content: ContentBlock[]) {
  const image = content.find((part) => part.type === 'image')
  if (!image) return text

  const metadata = fileImageMetadataSchema.safeParse(parseMetadata(text))
  const maxEncodedLength = 4 * Math.ceil(FILE_IMAGE_MAX_BYTES / 3)
  if (
    !metadata.success ||
    image.mimeType !== metadata.data.mediaType ||
    !image.data ||
    image.data.length > maxEncodedLength
  ) {
    throw new ToolError('Invalid image preview from the filesystem service')
  }
  return { ...metadata.data, base64: image.data }
}

function parseMetadata(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new ToolError('Invalid metadata from the filesystem service')
  }
}

export function readFileToModelOutput(
  output: unknown,
  omitMedia = false,
): ModelOutput {
  if (typeof output === 'string') return { type: 'text', value: output }
  if (!isFileImageOutput(output))
    return { type: 'json', value: (output ?? null) as JSONValue }
  const { base64, ...metadata } = output
  if (omitMedia) return { type: 'json', value: metadata }

  return {
    type: 'content',
    value: [
      { type: 'text', text: JSON.stringify(metadata) },
      {
        type: 'file',
        data: { type: 'data', data: base64 },
        mediaType: metadata.mediaType,
      },
    ],
  }
}

export function readFileHistoryTools(): ToolSet {
  const mapper = {
    toModelOutput: ({ output }: { output: unknown }) =>
      readFileToModelOutput(output),
  } as unknown as Tool
  return { [READ_FILE_TOOL_NAME]: mapper }
}
