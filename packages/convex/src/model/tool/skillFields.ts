import { z } from 'zod'

export const listSkillsFields = {
  search: z.string().max(64).optional(),
  cursor: z.string().max(8192).optional(),
} as const

export const readSkillFields = {
  skill_id: z.string().min(1).max(1024),
  resource: z.string().min(1).max(4096).optional(),
  offset: z.number().int().nonnegative().default(0),
  length: z.number().int().min(1).max(50_000).default(50_000),
} as const
