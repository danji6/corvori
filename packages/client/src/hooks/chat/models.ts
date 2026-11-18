import type { UIModel, UIModelConfig } from '@/lib/chat'
import { api } from '@cv/convex/_generated/api'
import { useQuery } from 'convex/react'
import { useMemo } from 'react'

import type { ActiveAgent } from './agent'
import { useActiveSession } from './session'
import { useSettings } from './settings'

export type ModelsConfig = {
  models: UIModel[]
  isLoading: boolean
}

export function useModels(): ModelsConfig {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = useQuery((api as any).models.list) as UIModelConfig | undefined
  return {
    models: data?.models ?? [],
    isLoading: data === undefined,
  }
}

export function findOverrideModel(
  models: UIModel[],
  id?: string,
  projection?: UIModel,
): UIModel | null {
  if (!id) return null
  const saved = models.find((model) => model.id === id)
  if (saved) return saved
  if (projection?.id === id) return projection
  return { id, available: false }
}

export function useActiveModel(agent: ActiveAgent | null): UIModel | null {
  const session = useActiveSession()
  const settings = useSettings()
  const { models, isLoading } = useModels()
  const modelId = session?.model?.id ?? settings?.recentModel

  return useMemo(() => {
    if (agent?.modelOverride) {
      const projection =
        'overrideModel' in agent ? agent.overrideModel : undefined
      return findOverrideModel(models, agent.modelOverride.modelId, projection)
    }
    if (session?.model) return session.model
    if (isLoading || !modelId) return null
    return models.find((m) => m.id === modelId) ?? { id: modelId }
  }, [agent, session, modelId, models, isLoading])
}
