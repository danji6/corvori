import { v } from 'convex/values'

import { internalMutation, internalQuery } from './_generated/server'
import { authMutation, authQuery } from './functions'
import * as Catalog from './model/provider/catalog'
import * as Connections from './model/provider/connections'
import * as Mutations from './model/provider/mutations'
import * as Previews from './model/provider/previews'
import * as Save from './model/provider/save'
import { storePreviewArgsValidator } from './validators/discovery'
import {
  beginDiscoveryArgsValidator,
  detailTargetsArgsValidator,
  discoveryRunValidator,
  enrichModelArgsValidator,
  finishDiscoveryArgsValidator,
  previewDetailArgsValidator,
  stageDiscoveryArgsValidator,
} from './validators/discovery'
import * as V from './validators/providers'

export const list = authQuery({
  args: {},
  handler: Connections.list,
})

export const create = authMutation({
  args: V.createModelProviderArgsValidator.fields,
  handler: Mutations.create,
})

export const update = authMutation({
  args: V.updateModelProviderArgsValidator.fields,
  handler: Mutations.update,
})

export const setModelInference = authMutation({
  args: V.setModelInferenceArgsValidator.fields,
  handler: Connections.setModelInference,
})

export const setApiKey = authMutation({
  args: { providerId: v.id('modelProviders'), apiKey: v.string() },
  handler: Connections.setApiKey,
})

export const remove = authMutation({
  args: { providerId: v.id('modelProviders') },
  handler: Mutations.remove,
})

export const get = authQuery({
  args: { providerId: v.id('modelProviders') },
  handler: Connections.get,
})

export const catalog = authQuery({
  args: { providerId: v.id('modelProviders') },
  handler: Catalog.catalog,
})

export const _connection = internalQuery({
  args: { providerId: v.id('modelProviders'), ownerId: v.id('users') },
  handler: Connections.connection,
})

export const _beginDiscovery = internalMutation({
  args: beginDiscoveryArgsValidator.fields,
  handler: Catalog.begin,
})

export const _stageDiscovery = internalMutation({
  args: stageDiscoveryArgsValidator.fields,
  handler: Catalog.stage,
})

export const _finishDiscovery = internalMutation({
  args: finishDiscoveryArgsValidator.fields,
  handler: Mutations.finishDiscovery,
})

export const _cleanupCatalog = internalMutation({
  args: { providerId: v.id('modelProviders') },
  handler: Catalog.cleanup,
})

export const _expireDiscovery = internalMutation({
  args: discoveryRunValidator.fields,
  handler: Catalog.expire,
})

export const save = authMutation({
  args: V.saveProvidersArgsValidator.fields,
  handler: Save.saveProviders,
})

export const ensureConnection = authMutation({
  args: V.ensureConnectionArgsValidator.fields,
  handler: Save.ensureConnection,
})

export const _storePreview = internalMutation({
  args: storePreviewArgsValidator.fields,
  handler: Previews.storePreview,
})

export const _deletePreview = internalMutation({
  args: { previewId: v.id('discoveryPreviews') },
  handler: Previews.deletePreview,
})

export const owner = authQuery({ args: {}, handler: (ctx) => ctx.userId })

export const _resetDiscovery = internalMutation({
  args: { providerId: v.id('modelProviders') },
  handler: Catalog.reset,
})

export const previewCatalog = authQuery({
  args: { previewId: v.id('discoveryPreviews') },
  handler: Previews.catalog,
})

export const _enrichModel = internalMutation({
  args: enrichModelArgsValidator.fields,
  handler: Mutations.enrichModel,
})

export const _enrichPreview = internalMutation({
  args: previewDetailArgsValidator.fields,
  handler: Previews.enrich,
})

export const _detailTargets = internalQuery({
  args: detailTargetsArgsValidator.fields,
  handler: Catalog.detailTargets,
})
