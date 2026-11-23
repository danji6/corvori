import { type Infer, v } from 'convex/values'

import {
  mcpLaunchFields,
  mcpToolMetaValidator,
  mcpTransportValidator,
} from './mcp'

export const toolkitSchema = v.object({
  ownerId: v.id('users'),
  root: v.string(),
  name: v.string(),
  version: v.optional(v.string()),
  revision: v.string(),
  manifest: v.string(),
  skillsEnabled: v.boolean(),
  disabledSkills: v.array(v.string()),
  status: v.union(
    v.literal('ready'),
    v.literal('changed'),
    v.literal('missing'),
  ),
  diagnostic: v.optional(v.string()),
})

export const toolkitIdValidator = v.object({
  toolkitId: v.id('toolkits'),
})

export const toolkitPublishValidator = v.object({
  subject: v.string(),
  toolkitId: v.optional(v.id('toolkits')),
  root: v.string(),
  revision: v.string(),
  manifest: v.string(),
  previousRevision: v.optional(v.string()),
  connections: v.array(
    v.object({
      name: v.string(),
      url: v.string(),
      transport: mcpTransportValidator,
      ...mcpLaunchFields,
    }),
  ),
})

export type ToolkitPublishArgs = Infer<typeof toolkitPublishValidator>

export const toolkitSettingsValidator = v.object({
  ...toolkitIdValidator.fields,
  skillsEnabled: v.optional(v.boolean()),
  disabledSkills: v.optional(v.array(v.string())),
  skill: v.optional(v.object({ name: v.string(), enabled: v.boolean() })),
})

export type ToolkitSettingsArgs = Infer<typeof toolkitSettingsValidator>

export const toolkitSelectionValidator = v.object({
  ...toolkitIdValidator.fields,
  agentId: v.id('agents'),
  enabled: v.boolean(),
})

export type ToolkitSelectionArgs = Infer<typeof toolkitSelectionValidator>

export const toolkitListValidator = v.object({
  agentId: v.optional(v.id('agents')),
})

export type ToolkitListArgs = Infer<typeof toolkitListValidator>

export const toolkitComponentValidator = v.object({
  tools: v.optional(v.array(mcpToolMetaValidator)),
  serverId: v.id('mcpServers'),
  enabled: v.boolean(),
  env: v.optional(v.record(v.string(), v.string())),
  secretEnv: v.optional(v.record(v.string(), v.string())),
  apiKey: v.optional(v.string()),
})

export type ToolkitComponentArgs = Infer<typeof toolkitComponentValidator>

export const toolkitMissingValidator = v.object({
  ...toolkitIdValidator.fields,
  subject: v.string(),
  acceptedRevision: v.string(),
  diagnostic: v.string(),
})

export type ToolkitMissingArgs = Infer<typeof toolkitMissingValidator>

export const toolkitObservationValidator = v.object({
  acceptedRevision: v.string(),
  streamId: v.id('streams'),
  generation: v.number(),
  toolkitId: v.id('toolkits'),
  observedRevision: v.optional(v.string()),
  diagnostic: v.optional(v.string()),
})

export type ToolkitObservationArgs = Infer<typeof toolkitObservationValidator>

export const toolkitSkillsValidator = v.object({
  ...toolkitIdValidator.fields,
  offset: v.number(),
  fingerprint: v.optional(v.string()),
})

export type ToolkitSkillsArgs = Infer<typeof toolkitSkillsValidator>
