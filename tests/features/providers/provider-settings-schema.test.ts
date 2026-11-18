/// <reference types="bun-types" />
import {
  modelEntrySchema,
  providerSchema,
} from '@/components/chat/entities/user/settings-schema'
import { describe, expect, test } from 'bun:test'

describe('provider settings schema', () => {
  test('rejects negative context windows while allowing a blank window or zero', () => {
    const model = { id: 'model' }
    expect(modelEntrySchema.safeParse(model).success).toBe(true)
    expect(
      modelEntrySchema.safeParse({ ...model, contextWindow: 0 }).success,
    ).toBe(true)
    expect(
      modelEntrySchema.safeParse({ ...model, contextWindow: -100 }).success,
    ).toBe(false)
  })

  test('accepts optional per-model inference parameters', () => {
    expect(
      providerSchema.safeParse({
        id: 'openai',
        enabled: true,
        models: [
          {
            id: 'gpt-test',
            inference: { temperature: 0.4, frequencyPenalty: 0.2 },
          },
        ],
      }).success,
    ).toBe(true)
  })

  test('requires a manually configured Qwen base URL', () => {
    const result = providerSchema.safeParse({
      id: 'qwen',
      enabled: true,
      models: [],
    })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          path: ['baseURL'],
          message: 'Base URL is required for this provider',
        }),
      )
    }
  })

  test('accepts a manually configured Qwen base URL', () => {
    expect(
      providerSchema.safeParse({
        id: 'qwen',
        baseURL: 'https://qwen.example/v1',
        enabled: true,
        models: [],
      }).success,
    ).toBe(true)
  })
})
