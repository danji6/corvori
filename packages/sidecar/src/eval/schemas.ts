import { MAX_SCOPE_PROMPTS } from '@cv/core/limits'
import { z } from 'zod'

import { workspaceContextSchema } from '../mcp/workspace/context'

const contextSchema = z.object({
  user: z.string().optional(),
  assistant: z.string().optional(),
  owner: z.string().optional(),
  modelId: z.string().optional(),
  modelName: z.string().optional(),
  tools: z.array(z.string()).optional(),
  isAdmin: z.boolean().optional(),
  userCount: z.number().optional(),
  agentCount: z.number().optional(),
  agentDir: z.string().optional(),
  workDir: z.string().optional(),
  workDirs: z.array(z.string()).optional(),
})

const requestSchema = z.object({
  context: contextSchema,
  environment: z.record(z.string(), z.json()).default({}),
  // Set by the authenticated backend from its trusted invoker/workspace state
  authorizedAgentId: z.string().optional(),
  authorizedAgentDir: z.string().optional(),
  authorizedWorkDir: z.string().optional(),
  authorizedWorkDirs: z.array(z.string()).optional(),
})

const records = z
  .array(z.record(z.string(), z.unknown()))
  .max(MAX_SCOPE_PROMPTS * 4)

export const promptsSchema = requestSchema.extend({ items: records })

export const messageSchema = requestSchema.extend({ parts: records })

export const evaluationShellSchema = z.object({
  sessionId: z.string(),
  workspaceId: z.string(),
  workspace: workspaceContextSchema,
  shell: z.string().optional(),
})

export const authoredEvaluationSchema = requestSchema.extend({
  texts: z.array(z.string()).max(MAX_SCOPE_PROMPTS * 4),
  kind: z.enum(['prompt', 'message']),
  shell: evaluationShellSchema.optional(),
  shellWorkspaceRequired: z.literal(true).optional(),
})

export const evaluationOperationSchema = z.object({
  id: z.string().min(1).max(128),
  bootId: z.string().min(1).max(128),
})
