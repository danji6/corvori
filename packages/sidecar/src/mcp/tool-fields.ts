import {
  editFileFields as editFileInput,
  readFileFields as readFileInput,
  writeFileFields as writeFileInput,
} from '@cv/core/types/workspace-tools'
import { z } from 'zod'

import { workspaceContextSchema } from './workspace/context'

const fileAccessFields = {
  allowedPaths: z.array(z.string()).optional(),
  allowOutsideWorkspace: z.boolean().optional(),
}

const workspaceFields = {
  sessionId: z.string(),
  workspaceId: z.string(),
  workspace: workspaceContextSchema,
}

export const readFileFields = {
  ...workspaceFields,
  ...readFileInput,
  ...fileAccessFields,
} as const

export const writeFileFields = {
  ...workspaceFields,
  ...writeFileInput,
  ...fileAccessFields,
} as const

export const editFileFields = {
  ...workspaceFields,
  ...editFileInput,
  ...fileAccessFields,
} as const

export const shellFields = {
  ...workspaceFields,
  command: z.string(),
  cwd: z.string().optional(),
  allowedPaths: z.array(z.string()).optional(),
  timeout: z.number().optional(),
} as const

export const checkPathsFields = {
  ...workspaceFields,
  paths: z.array(z.string()),
  allowedPaths: z.array(z.string()).optional(),
  literal: z.boolean().optional(),
  fileLoop: z.literal(true).optional(),
  sessionPaths: z.array(z.string()).max(32).optional(),
  shell: z.string().optional(),
  cwd: z.string().optional(),
} as const
