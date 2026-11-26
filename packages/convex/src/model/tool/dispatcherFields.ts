import type { JSONSchema7 } from 'ai'
import { z } from 'zod'

export const getToolFields = { name: z.string().min(1).max(1024) } as const

export const callToolFields = {
  ...getToolFields,
  arguments: z.object({}).catchall(z.unknown()),
} as const

export const dispatchErrorSchema = {
  type: 'object',
  properties: { error: { type: 'string' } },
  required: ['error'],
} satisfies JSONSchema7
