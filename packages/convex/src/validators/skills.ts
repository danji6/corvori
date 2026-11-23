import { paginationOptsValidator } from 'convex/server'
import { type Infer, v } from 'convex/values'

import { streamExecutionArgsValidator } from './streams'

export const skillReadArgsValidator = v.object({
  ...streamExecutionArgsValidator.fields,
  name: v.string(),
  resource: v.string(),
  offset: v.number(),
  length: v.number(),
})

export type SkillReadArgs = Infer<typeof skillReadArgsValidator>

export const projectSkillReadArgsValidator = v.object({
  ...skillReadArgsValidator.fields,
  sourceId: v.string(),
})

export type ProjectSkillReadArgs = Infer<typeof projectSkillReadArgsValidator>

export const toolkitSkillReadArgsValidator = v.object({
  ...skillReadArgsValidator.fields,
  toolkitId: v.string(),
})

export type ToolkitSkillReadArgs = Infer<typeof toolkitSkillReadArgsValidator>

export const verifySkillIdsValidator = v.object({
  skillIds: v.array(v.id('skills')),
})

export type VerifySkillIdsArgs = Infer<typeof verifySkillIdsValidator>

export const skillVerificationPageValidator = v.object({
  missing: v.array(v.object({ skillId: v.id('skills'), name: v.string() })),
  checked: v.number(),
  skipped: v.number(),
  isDone: v.boolean(),
  continueCursor: v.string(),
})

export type SkillVerificationPage = Infer<typeof skillVerificationPageValidator>

export const removeMissingSkillArgsValidator = v.object({
  skillId: v.id('skills'),
  ownerId: v.id('users'),
  importOperationId: v.optional(v.id('agentFileOperations')),
})

export type RemoveMissingSkillArgs = Infer<
  typeof removeMissingSkillArgsValidator
>

export const skillAssignmentsArgsValidator = v.object({
  agentId: v.id('agents'),
  paginationOpts: paginationOptsValidator,
  search: v.optional(v.string()),
  enabledOnly: v.optional(v.boolean()),
})

export type SkillAssignmentsArgs = Infer<typeof skillAssignmentsArgsValidator>

export const setSkillEnabledArgsValidator = v.object({
  agentId: v.id('agents'),
  assignmentId: v.id('agentSkills'),
  enabled: v.boolean(),
})

export type SetSkillEnabledArgs = Infer<typeof setSkillEnabledArgsValidator>

export const prepareSkillImportArgsValidator = v.object({
  attempt: v.number(),
  operationId: v.id('agentFileOperations'),
  cursor: v.number(),
  metadata: v.object({ name: v.string(), description: v.string() }),
})

export type PrepareSkillImportArgs = Infer<
  typeof prepareSkillImportArgsValidator
>

export const finishSkillImportArgsValidator = v.object({
  attempt: v.number(),
  operationId: v.id('agentFileOperations'),
  cursor: v.number(),
  nextCursor: v.number(),
  skillId: v.optional(v.id('skills')),
  outcome: v.union(
    v.literal('installed'),
    v.literal('skipped'),
    v.literal('failed'),
  ),
  message: v.optional(v.string()),
})

export type FinishSkillImportArgs = Infer<typeof finishSkillImportArgsValidator>

export const skillListArgsValidator = v.object({
  paginationOpts: paginationOptsValidator,
  search: v.optional(v.string()),
  agentId: v.optional(v.id('agents')),
  assignment: v.optional(v.union(v.literal('added'), v.literal('not-added'))),
})

export type SkillListArgs = Infer<typeof skillListArgsValidator>

export const continueSkillImportArgsValidator = v.object({
  operationId: v.id('agentFileOperations'),
  cursor: v.number(),
  attempt: v.number(),
})

export type ContinueSkillImportArgs = Infer<
  typeof continueSkillImportArgsValidator
>

/** An owner-bound upload ticket and its verified storage object. */
export const skillUploadSchema = v.object({
  ownerId: v.id('users'),
  storageId: v.optional(v.id('_storage')),
  ticket: v.string(),
  verified: v.boolean(),
})

export const skillSchema = v.object({
  ownerId: v.id('users'),
  name: v.string(),
  description: v.string(),
  status: v.union(
    v.literal('installing'),
    v.literal('ready'),
    v.literal('failed'),
  ),
  operationId: v.optional(v.id('agentFileOperations')),
  importOperationId: v.optional(v.id('agentFileOperations')),
})

export const agentSkillSchema = v.object({
  homeId: v.id('agentHomes'),
  ownerId: v.id('users'),
  /** Retains the source identity for toggles after the library bundle is deleted. */
  skillId: v.id('skills'),
  name: v.string(),
  description: v.string(),
})
