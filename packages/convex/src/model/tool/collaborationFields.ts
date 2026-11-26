import {
  MAX_ASK_OPTIONS,
  MAX_ASK_OPTION_DESCRIPTION_CHARS,
  MAX_ASK_OPTION_LABEL_CHARS,
  MAX_ASK_QUESTIONS,
  MAX_ASK_QUESTION_CHARS,
  MAX_ASK_RESPONSE_CHARS,
} from '@cv/core/limits'
import { z } from 'zod'

const option = z.object({
  label: z.string().trim().min(1).max(MAX_ASK_OPTION_LABEL_CHARS),
  description: z
    .string()
    .trim()
    .min(1)
    .max(MAX_ASK_OPTION_DESCRIPTION_CHARS)
    .optional(),
  recommended: z.boolean().optional(),
})

const question = z
  .object({
    question: z.string().trim().min(1).max(MAX_ASK_QUESTION_CHARS),
    options: z.array(option).min(2).max(MAX_ASK_OPTIONS),
    multiple: z.boolean().optional(),
  })
  .superRefine(({ options }, ctx) => {
    const labels = new Set(options.map(({ label }) => label.toLowerCase()))
    if (labels.size !== options.length) {
      ctx.addIssue({
        code: 'custom',
        message: 'Option labels must be unique within a question.',
        path: ['options'],
      })
    }
    if (options.filter(({ recommended }) => recommended).length > 1) {
      ctx.addIssue({
        code: 'custom',
        message: 'At most one option may be recommended.',
        path: ['options'],
      })
    }
  })

export const askFields = {
  questions: z.array(question).min(1).max(MAX_ASK_QUESTIONS),
} as const

export const askOutputSchema = z.union([
  z.object({
    aborted: z.literal(true),
    reason: z.string(),
  }),
  z.object({
    answeredBy: z.string(),
    answers: z.array(
      z.union([
        z.object({
          questionIndex: z.number().int().nonnegative(),
          question: z.string(),
          skipped: z.literal(true),
        }),
        z.object({
          questionIndex: z.number().int().nonnegative(),
          question: z.string(),
          answer: z.string().max(MAX_ASK_RESPONSE_CHARS),
          selectedOptionIndices: z
            .array(z.number().int().nonnegative())
            .min(1)
            .max(MAX_ASK_OPTIONS)
            .optional(),
          note: z.string().max(MAX_ASK_RESPONSE_CHARS).optional(),
          skipped: z.literal(false).optional(),
        }),
      ]),
    ),
    aborted: z.literal(false).optional(),
  }),
])

const MAX_AGENT_NAME_CHARS = 200

export const yieldFields = {
  name: z.string().trim().min(1).max(MAX_AGENT_NAME_CHARS),
} as const

export const yieldOutputSchema = z.union([
  z.object({ accepted: z.literal(true), agent: z.string() }),
  z.object({ accepted: z.literal(false), reason: z.string() }),
])

export const taskFields = {
  agent_name: z.string().describe('Name of the agent to delegate to'),
  prompt: z
    .string()
    .describe(
      'Complete standalone task, including what the report must contain',
    ),
  title: z
    .string()
    .optional()
    .describe('Short task title (3-6 words), shown to the user'),
} as const
