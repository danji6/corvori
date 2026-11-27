import {
  AgentCombobox,
  AgentItemLabel,
} from '@/components/chat/sessions/agent-combobox'
import { FolderPicker } from '@/components/chat/sessions/folder-picker'
import { Combobox } from '@/components/ui/combobox'
import { Input } from '@/components/ui/input'
import { RippleButton } from '@/components/ui/ripple-button'
import { Textarea } from '@/components/ui/textarea'
import { findOverrideModel, useModels } from '@/hooks/chat/models'
import { useIsAdmin } from '@/hooks/chat/tools'
import { extractErrorMessage } from '@/lib/errors'
import { api } from '@cv/convex/_generated/api'
import type { Doc, Id } from '@cv/convex/_generated/dataModel'
import type { TaskApprovals } from '@cv/convex/validators/scheduledTasks'
import {
  defaultModelReasoning,
  normalizeReasoningEffort,
} from '@cv/core/model-reasoning'
import { workspaceKey } from '@cv/core/workspace/transition'
import { useMutation, useQuery } from 'convex/react'
import { useId, useState } from 'react'
import { useLocation } from 'wouter'

import { TaskApprovalFields } from './task-approval-fields'
import { TaskModelFields, type TaskModelSettings } from './task-model-fields'
import { RecurrenceEditor, defaultSchedule } from './task-recurrence'
import { fieldStyle } from './task-schedule-fields'

const emptyApprovals: TaskApprovals = { shell: [], paths: [] }

export function TaskEditor({ task }: { task?: Doc<'scheduledTasks'> }) {
  const [, navigate] = useLocation()
  const agents = useQuery(api.agents.list, {})
  const settings = useQuery(api.settings.get, task ? 'skip' : {})
  const { models, isLoading: modelsLoading } = useModels()
  const agentFieldId = useId()
  const save = useMutation(api.scheduledTasks.save)
  const [rule, setRule] = useState(() => task?.schedule ?? defaultSchedule())
  const [agentId, setAgentId] = useState<string | undefined>(task?.agentId)
  const [folderId, setFolderId] = useState(task?.folderId)
  const [approvalDraft, setApprovalDraft] = useState({
    grants: task?.approvals ?? emptyApprovals,
    reviewedKey: task?.approvalWorkspaceKey,
  })
  const isAdmin = useIsAdmin()
  const folder = useQuery(
    api.sessionFolders.get,
    folderId ? { folderId } : 'skip',
  )
  const [modelSelection, setModelSelection] = useState<TaskModelSettings>()
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  const back = task ? '/tasks/' + task._id : '/tasks'
  const agentItems = (agents ?? []).map(
    ({ _id, name, avatarId, modelOverride }) => ({
      id: _id,
      name,
      avatarId,
      modelOverride,
    }),
  )
  const selectedAgent = agentItems.find((agent) => agent.id === agentId)
  const override = selectedAgent?.modelOverride
  const selection = modelSelection ??
    task ?? {
      modelId: settings?.recentModel,
      reasoningEffort:
        settings?.recentReasoning as TaskModelSettings['reasoningEffort'],
    }
  const model = findOverrideModel(
    models,
    override?.modelId ?? selection.modelId,
  )
  const capability = model?.reasoning ?? defaultModelReasoning()
  const effort = selection.reasoningEffort
  const reasoningEffort =
    capability.type !== 'none' &&
    normalizeReasoningEffort(effort, capability) === effort
      ? effort
      : undefined
  const needsEffort =
    capability.type !== 'none' && override?.reasoningEffort === undefined
  const modelSelectionComplete =
    !modelsLoading &&
    !!model &&
    model.available !== false &&
    (!needsEffort || reasoningEffort !== undefined)
  const currentKey = workspaceKey(folder?.workspace)
  const workspaceReady = !folderId || !!folder?.workspace
  const { grants, reviewedKey } = approvalDraft
  const hasGrants = grants.shell.length > 0 || grants.paths.length > 0
  const needsApprovalReview = hasGrants && reviewedKey !== currentKey
  const ready =
    modelSelectionComplete &&
    workspaceReady &&
    !needsApprovalReview &&
    (!hasGrants || isAdmin)

  function changeAgent(next: string) {
    if (next !== agentId)
      setApprovalDraft({ grants: emptyApprovals, reviewedKey: undefined })
    setAgentId(next)
  }

  function changeWorkspace(next: string | null) {
    if (next !== (folderId ?? null))
      setApprovalDraft({ grants: emptyApprovals, reviewedKey: undefined })
    setFolderId((next ?? undefined) as Id<'sessionFolders'> | undefined)
  }

  async function submit(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy || !selectedAgent || !ready) return
    const fields = new FormData(event.currentTarget)
    setBusy(true)
    setFailure('')
    try {
      const id = await save({
        taskId: task?._id,
        reviewedWorkspaceKey: hasGrants && folderId ? reviewedKey : undefined,
        definition: {
          folderId,
          approvals: hasGrants ? grants : undefined,
          modelId: selection.modelId,
          reasoningEffort,
          title: String(fields.get('title')),
          prompt: String(fields.get('prompt')),
          agentId: selectedAgent.id,
          schedule: rule,
        },
      })
      navigate('/tasks/' + id, { replace: true })
    } catch (cause) {
      setFailure(extractErrorMessage(cause))
      setBusy(false)
    }
  }
  return (
    <form onSubmit={submit} className="mx-auto grid w-full max-w-xl gap-5">
      <h1 className="text-2xl font-semibold">
        {task ? 'Edit task' : 'New task'}
      </h1>
      <label className={fieldStyle}>
        <span>
          Title <span className="text-muted-foreground">(optional)</span>
        </span>
        <Input
          name="title"
          maxLength={200}
          defaultValue={task?.title}
          placeholder="e.g. Check mails"
        />
      </label>
      <div className={fieldStyle}>
        <label htmlFor={agentFieldId}>Agent</label>
        <AgentCombobox
          agents={agentItems}
          value={selectedAgent?.id}
          onValueChange={changeAgent}
          noDeselect
          trigger={
            <Combobox.Trigger
              id={agentFieldId}
              aria-required="true"
              className="h-11"
            >
              <Combobox.DisplayValue>
                <AgentItemLabel agent={selectedAgent} />
              </Combobox.DisplayValue>
            </Combobox.Trigger>
          }
        />
      </div>
      <TaskModelFields
        override={override}
        model={model}
        value={{ modelId: selection.modelId, reasoningEffort }}
        onChange={setModelSelection}
      />
      <div className={fieldStyle}>
        <span>Workspace</span>
        <FolderPicker
          value={folderId}
          onChange={changeWorkspace}
          label="Workspace"
          rootLabel="No workspace"
          workspaceOnly
        />
        {folderId && folder !== undefined && !folder?.workspace && (
          <p role="status">Choose an available project workspace.</p>
        )}
      </div>
      {isAdmin && workspaceReady && (
        <TaskApprovalFields
          value={grants}
          onChange={(grants) =>
            setApprovalDraft({
              grants,
              reviewedKey: hasGrants ? reviewedKey : currentKey,
            })
          }
          hasWorkspace={!!folderId}
          needsReview={needsApprovalReview}
          onReview={() => setApprovalDraft({ grants, reviewedKey: currentKey })}
        />
      )}
      {!isAdmin && hasGrants && (
        <div className={fieldStyle}>
          <p>Administrator access is required to keep automatic approvals.</p>
          <RippleButton
            type="button"
            variant="surface"
            onClick={() =>
              setApprovalDraft({
                grants: emptyApprovals,
                reviewedKey: undefined,
              })
            }
          >
            Remove automatic approvals
          </RippleButton>
        </div>
      )}
      <label className={fieldStyle}>
        Prompt
        <Textarea
          required
          name="prompt"
          rows={4}
          maxLength={16000}
          defaultValue={task?.prompt}
          placeholder="What should the agent do?"
        />
      </label>
      <RecurrenceEditor rule={rule} onChange={setRule} />
      {failure && (
        <p role="alert" className="text-destructive">
          {failure}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <RippleButton
          variant="surface"
          disabled={busy}
          onClick={() => navigate(back)}
        >
          Cancel
        </RippleButton>
        <RippleButton type="submit" disabled={busy || !selectedAgent || !ready}>
          {busy ? 'Saving…' : 'Save task'}
        </RippleButton>
      </div>
    </form>
  )
}
