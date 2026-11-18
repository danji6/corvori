import { providerForm, providerSaveInput } from '@/lib/provider-settings'
import { deletePreview, storePreview } from '@cv/convex/model/provider/previews'
import { ensureConnection, saveProviders } from '@cv/convex/model/provider/save'
import {
  create,
  list,
  resolve,
  setModelInference,
  update,
} from '@cv/convex/model/providers'
import { discoveryFingerprint } from '@cv/core/discovery-fingerprint'
import { modelReference } from '@cv/core/model-reference'
import { expect, test } from 'bun:test'
import { providerFixture } from '~/tests/helpers/provider-db'

test('saving an edited model ID updates chat selections for that connection', async () => {
  const { ctx } = providerFixture()
  const models = [{ id: 'old' }]
  const id = await create(ctx, { key: 'openai', enabled: true, models })
  const other = await create(ctx, {
    key: 'openai',
    enabled: true,
    models: [{ id: 'old' }],
  })
  const recent = await ctx.db.insert('settings', {
    ownerId: ctx.userId,
    recentModel: modelReference(id, 'old'),
  })
  const agentId = await ctx.db.insert('agents', {
    name: 'Assistant',
    ownerId: ctx.userId,
  })
  async function select(modelId: string) {
    const sessionId = await ctx.db.insert('sessions', {
      ownerId: ctx.userId,
      activeAgentId: agentId,
      model: { id: modelId },
    })
    await ctx.db.insert('sessionAgents', {
      sessionId,
      agentId,
      addedBy: ctx.userId,
    })
    return sessionId
  }

  const selected = await select(modelReference(id, 'old'))
  const otherSelection = await select(modelReference(other, 'old'))
  const draft = providerForm((await list(ctx))[0])
  draft.models[0] = { ...draft.models[0], id: 'new', label: 'New model' }

  await saveProviders(ctx, {
    connections: [providerSaveInput(draft)],
    removed: [],
  })

  expect((await ctx.db.get(selected))?.model).toMatchObject({
    id: modelReference(id, 'new'),
    label: 'New model',
  })
  expect((await ctx.db.get(otherSelection))?.model?.id).toBe(
    modelReference(other, 'old'),
  )
  expect((await ctx.db.get(recent))?.recentModel).toBe(
    modelReference(id, 'new'),
  )
})

test('global batch save preserves identities and credentials and accepts duplicate default names', async () => {
  const { ctx } = providerFixture()
  const id = await create(ctx, {
    key: 'openai',
    enabled: true,
    apiKey: 'fixture-key',
    models: [],
  })
  const result = await saveProviders(ctx, {
    connections: [
      {
        key: 'openai',
        enabled: true,
        models: [{ id: 'model' }],
        providerId: id,
        clientId: 'existing',
        configRevision: 0,
      },
      { key: 'openai', enabled: false, models: [], clientId: 'new' },
    ],
    removed: [],
  })
  expect(result[0].providerId).toBe(id)
  expect((await resolve(ctx, ctx.userId))[0].apiKey).toBe('fixture-key')
  expect((await list(ctx)).map((row) => row.name)).toEqual(['OpenAI', 'OpenAI'])
  expect(result[0].configRevision).toBe(1)
  await expect(
    saveProviders(ctx, {
      connections: [
        {
          key: 'openai',
          enabled: true,
          models: [],
          providerId: id,
          clientId: 'existing',
          configRevision: 0,
        },
      ],
      removed: [],
    }),
  ).rejects.toThrow('Connection changed')
})

test('sign-in creates an idempotent identity independently of configuration and authentication does not change its settings revision', async () => {
  const { ctx } = providerFixture()
  const input = { key: 'openai', auth: 'chatgpt' as const, clientId: 'draft' }
  const first = await ensureConnection(ctx, input)
  expect(await ensureConnection(ctx, input)).toBe(first)
  expect((await list(ctx))[0]).toMatchObject({
    name: 'OpenAI',
    models: [],
    enabled: false,
    configRevision: 0,
  })
  await expect(
    ensureConnection(ctx, { ...input, key: 'anthropic' }),
  ).rejects.toThrow()
  const saved = await saveProviders(ctx, {
    connections: [{ ...input, configRevision: 0, models: [], enabled: true }],
    removed: [],
  })
  expect(saved[0].providerId).toBe(first)
  expect(await list(ctx)).toHaveLength(1)
})

test('preview adoption requires the same owner and exact network configuration, and expiry cannot remove a published catalog', async () => {
  const { ctx, find } = providerFixture()
  const connection = {
    id: 'openrouter',
    auth: 'apiKey' as const,
    apiKey: 'fixture-key',
    baseURL: 'https://router.test/v1',
  }
  const previewId = await storePreview(ctx, {
    ownerId: ctx.userId,
    fingerprint: await discoveryFingerprint(connection),
    models: [
      {
        id: 'one',
        label: 'One',
        contextWindow: 128000,
        reasoning: { type: 'effort', efforts: ['low', 'high'] },
      },
    ],
  })
  const input = {
    key: connection.id,
    auth: connection.auth,
    apiKey: connection.apiKey,
    baseURL: connection.baseURL,
    enabled: true,
    clientId: 'draft',
    previewId,
    models: [
      {
        id: 'one',
        source: 'discovered' as const,
        label: 'Custom',
        contextWindow: 128_000,
      },
    ],
  }
  await expect(
    saveProviders(ctx, {
      connections: [{ ...input, apiKey: 'different' }],
      removed: [],
    }),
  ).rejects.toThrow('Connection changed')
  const foreign = { ...ctx, userId: 'other' as typeof ctx.userId }
  await expect(
    saveProviders(foreign, { connections: [input], removed: [] }),
  ).rejects.toThrow('preview expired')
  const saved = await saveProviders(ctx, { connections: [input], removed: [] })
  const id = saved[0].providerId
  expect((await ctx.db.get(id))?.discovery?.generation).toBe(previewId)
  expect((await resolve(ctx, ctx.userId))[0].models[0]).toMatchObject({
    label: 'Custom',
    contextWindow: 128000,
    reasoning: { type: 'effort', efforts: ['low', 'high'] },
    available: true,
  })
  await deletePreview(ctx, { previewId })
  expect((await ctx.db.get(id))?.discovery?.generation).toBe(previewId)
  expect(find(previewId)).toBeUndefined()
})

test('explicit deletions check revision and duplicate save identities are rejected', async () => {
  const { ctx } = providerFixture()
  const id = await create(ctx, { key: 'openai', enabled: true, models: [] })
  await update(ctx, { providerId: id, name: 'Edited' })
  await expect(
    saveProviders(ctx, {
      connections: [],
      removed: [{ providerId: id, configRevision: 0 }],
    }),
  ).rejects.toThrow('Connection changed')
  expect(await list(ctx)).toHaveLength(1)
  const connection = {
    key: 'openai',
    clientId: 'duplicate',
    providerId: id,
    configRevision: 1,
    enabled: true,
    models: [],
  }
  await expect(
    saveProviders(ctx, { connections: [connection, connection], removed: [] }),
  ).rejects.toThrow('Duplicate connection')
  await saveProviders(ctx, {
    connections: [],
    removed: [{ providerId: id, configRevision: 1 }],
  })
  expect(await list(ctx)).toHaveLength(0)
})

test('subscription models retain custom inference and advanced settings', async () => {
  const { ctx } = providerFixture()
  const id = await create(ctx, {
    key: 'openai',
    auth: 'chatgpt',
    enabled: true,
    models: [],
  })
  // Discovery availability is server-owned; use the actual preview publication path.
  const model = {
    id: 'one',
    source: 'discovered' as const,
    contextWindow: 128_000,
    outputTokens: 4_096,
    trimContext: true,
    inference: { temperature: 0.7 },
    extraParameters: '{"max_output_tokens":400}',
  }
  const { begin, stage, finish } =
    await import('@cv/convex/model/provider/catalog')
  const run = {
    providerId: id,
    ownerId: ctx.userId,
    revision: 0,
    generation: 'catalog',
  }
  await begin(ctx, { ...run, force: true })
  await stage(ctx, {
    ...run,
    offset: 0,
    models: [{ id: 'one', contextWindow: 128_000 }],
  })
  await finish(ctx, run)
  await update(ctx, { providerId: id, models: [model] })
  await setModelInference(ctx, {
    modelId: modelReference(id, 'one'),
    inference: { temperature: 0.2 },
  })
  expect((await resolve(ctx, ctx.userId))[0].models[0]).toMatchObject({
    contextWindow: 128_000,
    outputTokens: 4_096,
    trimContext: true,
    inference: { temperature: 0.2 },
    extraParameters: '{"max_output_tokens":400}',
  })

  const draft = providerForm((await list(ctx))[0])
  await saveProviders(ctx, {
    connections: [providerSaveInput(draft)],
    removed: [],
  })

  const refreshed = {
    ...run,
    revision: (await ctx.db.get(id))?.configRevision ?? 0,
    generation: 'refresh',
  }
  const saved = (await ctx.db.get(id))!
  await ctx.db.patch(id, {
    discovery: { ...saved.discovery, attemptedAt: Date.now() - 20_000 },
  })
  expect(await begin(ctx, { ...refreshed, force: true })).toBe(true)
  await stage(ctx, {
    ...refreshed,
    offset: 0,
    models: [{ id: 'one', contextWindow: 256_000 }],
  })
  await finish(ctx, refreshed)
  const refreshedModel = (await resolve(ctx, ctx.userId))[0].models[0]
  expect(refreshedModel).toMatchObject({
    contextWindow: 128_000,
    outputTokens: 4_096,
    trimContext: true,
  })
  expect(refreshedModel.discovered?.contextWindow).toBe(256_000)

  const reset = providerForm((await list(ctx))[0])
  Object.assign(reset.models[0], {
    contextWindow: undefined,
    outputTokens: undefined,
    trimContext: undefined,
  })
  await saveProviders(ctx, {
    connections: [providerSaveInput(reset)],
    removed: [],
  })
  const cleared = (await resolve(ctx, ctx.userId))[0].models[0]
  expect(cleared.contextWindow).toBeUndefined()
  expect(cleared.outputTokens).toBeUndefined()
  expect(cleared.trimContext).toBeUndefined()
  expect(cleared.discovered?.contextWindow).toBe(256_000)
})

test('validates token settings before saving a provider model', async () => {
  const { ctx } = providerFixture()
  const provider = { key: 'openai', enabled: true }
  for (const outputTokens of [0, -1, 0.5, Infinity]) {
    await expect(
      create(ctx, { ...provider, models: [{ id: 'model', outputTokens }] }),
    ).rejects.toThrow('Output tokens must be a positive integer')
  }
  await expect(
    create(ctx, {
      ...provider,
      models: [{ id: 'model', contextWindow: -100 }],
    }),
  ).rejects.toThrow('Context window must be zero or a positive number')
  const id = await create(ctx, {
    ...provider,
    models: [{ id: 'model', contextWindow: 64_000 }],
  })
  await expect(
    update(ctx, {
      providerId: id,
      models: [{ id: 'model', contextWindow: -100 }],
    }),
  ).rejects.toThrow('Context window must be non-negative')
  await expect(
    create(ctx, { ...provider, models: [{ id: 'model', trimContext: true }] }),
  ).rejects.toThrow('Set a positive context window to enable trimming')
})

test('refreshing a changed endpoint preserves previously configured missing models as unavailable', async () => {
  const { ctx } = providerFixture()
  const id = await create(ctx, { key: 'openai', enabled: true, models: [] })
  const { begin, stage, finish } =
    await import('@cv/convex/model/provider/catalog')
  const run = {
    providerId: id,
    ownerId: ctx.userId,
    revision: 0,
    generation: 'old',
  }
  await begin(ctx, { ...run, force: true })
  await stage(ctx, { ...run, offset: 0, models: [{ id: 'previous' }] })
  await finish(ctx, run)
  await update(ctx, {
    providerId: id,
    configRevision: 0,
    models: [{ id: 'previous', source: 'discovered' }],
  })
  const connection = { id: 'openai', baseURL: 'https://changed.test/v1' }
  const previewId = await storePreview(ctx, {
    ownerId: ctx.userId,
    fingerprint: await discoveryFingerprint(connection),
    models: [{ id: 'different' }],
  })
  await saveProviders(ctx, {
    removed: [],
    connections: [
      {
        providerId: id,
        clientId: 'existing',
        configRevision: 1,
        key: 'openai',
        baseURL: connection.baseURL,
        enabled: true,
        previewId,
        models: [{ id: 'previous', source: 'discovered', label: 'Keep me' }],
      },
    ],
  })
  expect((await resolve(ctx, ctx.userId))[0].models[0]).toMatchObject({
    id: 'previous',
    label: 'Keep me',
    available: false,
  })
})
