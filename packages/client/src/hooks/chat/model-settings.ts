import type { InferenceParameters, ReasoningEffort, UIModel } from '@/lib/chat'
import { api } from '@cv/convex/_generated/api'
import {
  defaultModelReasoning,
  normalizeReasoningEffort as normalizeConfiguredEffort,
} from '@cv/core/model-reasoning'
import { useMutation } from 'convex/react'
import { useCallback, useMemo } from 'react'

import { useActiveAgent } from './agent'
import { findOverrideModel, useModels } from './models'
import { useActiveSession } from './session'
import { useSettings, useSettingsUpdate } from './settings'

export type ActiveModelSettingsState = {
  model: UIModel | null
  setModel: (model: UIModel | string) => void
  reasoningEffort: ReasoningEffort | undefined
  setReasoningEffort: (effort: ReasoningEffort) => void
  inference: InferenceParameters
  setInference: (inference: InferenceParameters) => void
  editable: boolean
  modelOverridden: boolean
  reasoningOverridden: boolean
}

export type ActiveModelInferenceState = {
  model: UIModel | null
  inference: InferenceParameters
  setInference: (inference: InferenceParameters) => void
  editable: boolean
}

export function normalizeReasoningEffort(
  effort: ReasoningEffort | undefined,
  configured?: UIModel['reasoning'],
): ReasoningEffort {
  return normalizeConfiguredEffort(
    effort,
    configured ?? defaultModelReasoning(),
  )
}

/** Session model controls, or recent defaults before a session exists. */
export function useActiveModelSettings(): ActiveModelSettingsState {
  const agent = useActiveAgent()
  const session = useActiveSession()
  const settings = useSettings()
  const updateSettings = useSettingsUpdate()
  const setSessionModel = useMutation(api.sessions.setModel)
  const setSessionReasoning = useMutation(api.sessions.setReasoningEffort)
  const setModelInference = useMutation(api.providers.setModelInference)
  const { models, isLoading } = useModels()

  const editable = Boolean(agent && 'ownerId' in agent)
  const override = agent?.modelOverride
  const projectedModel =
    agent && 'overrideModel' in agent ? agent.overrideModel : undefined
  const modelId = session ? session.model?.id : settings?.recentModel
  const defaultReasoningEffort = (
    session ? session.reasoningEffort : settings?.recentReasoning
  ) as ReasoningEffort | undefined
  const sessionModel = session?.model

  const model = useMemo(() => {
    if (override)
      return findOverrideModel(models, override.modelId, projectedModel)
    if (isLoading || !modelId) return null
    const configured = models.find((candidate) => candidate.id === modelId)
    if (sessionModel?.id !== modelId) return configured ?? { id: modelId }
    return {
      ...configured,
      ...sessionModel,
      subscription: configured?.subscription,
      inference: configured?.inference,
    }
  }, [isLoading, modelId, models, override, projectedModel, sessionModel])
  const modelOverridden = Boolean(override)
  const reasoningOverridden = override?.reasoningEffort !== undefined
  const reasoningEffort = override
    ? normalizeReasoningEffort(
        override.reasoningEffort ?? defaultReasoningEffort,
        model?.reasoning,
      )
    : defaultReasoningEffort

  const setModel = useCallback(
    (value: UIModel | string) => {
      if (!editable || modelOverridden) return
      const id = typeof value === 'string' ? value : value.id
      const selected = models.find((candidate) => candidate.id === id)
      const normalized = normalizeReasoningEffort(
        defaultReasoningEffort,
        selected?.reasoning,
      )

      if (session) {
        void setSessionModel({
          sessionId: session._id,
          modelId: id,
          reasoningEffort: normalized,
        })
        return
      }

      void updateSettings({
        patch: { recentModel: id, recentReasoning: normalized },
      })
    },
    [
      editable,
      models,
      defaultReasoningEffort,
      modelOverridden,
      session,
      setSessionModel,
      updateSettings,
    ],
  )

  const setReasoningEffort = useCallback(
    (value: ReasoningEffort) => {
      if (!editable || reasoningOverridden) return
      if (session) {
        void setSessionReasoning({
          sessionId: session._id,
          reasoningEffort: value,
        })
        return
      }
      void updateSettings({ patch: { recentReasoning: value } })
    },
    [
      editable,
      reasoningOverridden,
      session,
      setSessionReasoning,
      updateSettings,
    ],
  )

  const setInference = useCallback(
    (inference: InferenceParameters) => {
      if (!editable || !model) return
      void setModelInference({ modelId: model.id, inference })
    },
    [editable, model, setModelInference],
  )

  return {
    model,
    setModel,
    reasoningEffort,
    setReasoningEffort,
    inference: model?.inference ?? {},
    setInference,
    editable,
    modelOverridden,
    reasoningOverridden,
  }
}

/** Inference configuration for the selected owned provider model. */
export function useActiveModelInference(): ActiveModelInferenceState {
  const { model, inference, setInference, editable } = useActiveModelSettings()

  return {
    model,
    inference,
    setInference,
    editable,
  }
}
