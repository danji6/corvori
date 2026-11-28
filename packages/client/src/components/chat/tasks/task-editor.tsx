import { PromptContentEditor } from '@/components/chat/prompts/prompt-content-editor'
import {
  AgentCombobox,
  AgentItemLabel,
} from '@/components/chat/sessions/agent-combobox'
import { FolderPicker } from '@/components/chat/sessions/folder-picker'
import { Combobox } from '@/components/ui/combobox'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Input } from '@/components/ui/input'
import { RippleButton } from '@/components/ui/ripple-button'
import { usePromptDraft } from '@/hooks/chat/prompt-draft'
import {
  type TaskModelSettings,
  useTaskModelSelection,
} from '@/hooks/chat/tasks'
import { useIsAdmin } from '@/hooks/chat/tools'
import { taskDraftKey } from '@/lib/chat/editor-draft-store'
import { extractErrorMessage } from '@/lib/errors'
import type { EditorDocumentHandle } from '@/lib/tiptap/handle'
import { api } from '@cv/convex/_generated/api'
import type { Doc, Id } from '@cv/convex/_generated/dataModel'
import type { TaskApprovals } from '@cv/convex/validators/scheduledTasks'
import { MAX_TASK_PROMPT_CHARS } from '@cv/core/limits'
import type { TaskSchedule } from '@cv/core/task-schedule'
import { workspaceKey } from '@cv/core/workspace/transition'
import { useMutation, useQuery } from 'convex/react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import { useLocation } from 'wouter'

import { TaskApprovalFields } from './task-approval-fields'
import { TaskModelFields } from './task-model-fields'
import { RecurrenceEditor, defaultSchedule } from './task-recurrence'
import { fieldStyle } from './task-schedule-fields'

const emptyApprovals: TaskApprovals = { shell: [], paths: [] }
const dirty = { shouldDirty: true }

type TaskFormValues = {
  title: string
  content: string
  model: TaskModelSettings | null
  schedule: TaskSchedule
  target: {
    agentId: string | null
    folderId: Id<'sessionFolders'> | null
    grants: TaskApprovals
    reviewedKey: string | null
  }
}

function taskModelSettings({ modelId, reasoningEffort }: TaskModelSettings) {
  return {
    ...(modelId !== undefined && { modelId }),
    ...(reasoningEffort !== undefined && { reasoningEffort }),
  }
}

function taskFormValues(task?: Doc<'scheduledTasks'>): TaskFormValues {
  return {
    title: task?.title ?? '',
    content: task?.prompt ?? '',
    model: task ? taskModelSettings(task) : null,
    schedule: task?.schedule ?? defaultSchedule(),
    target: {
      agentId: task?.agentId ?? null,
      folderId: task?.folderId ?? null,
      grants: task?.approvals ?? emptyApprovals,
      reviewedKey: task?.approvalWorkspaceKey ?? null,
    },
  }
}

export function TaskEditor({ task }: { task?: Doc<'scheduledTasks'> }) {
  const [, navigate] = useLocation()
  const agents = useQuery(api.agents.list, {})
  const agentFieldId = useId()
  const promptLabelId = useId()
  const save = useMutation(api.scheduledTasks.save)
  const [initial] = useState(() => taskFormValues(task))
  const form = useForm<TaskFormValues>({ defaultValues: initial })
  const { control, getValues, register, setValue } = form
  const { isDirty } = form.formState
  const [content, model, schedule, target] = useWatch({
    control,
    name: ['content', 'model', 'schedule', 'target'],
  })
  const { agentId, folderId, grants, reviewedKey } = target
  const editor = useRef<EditorDocumentHandle>(null)
  const storedPromptBaseline = useRef(initial.content)
  const draft = usePromptDraft({
    key: taskDraftKey(task?._id),
    label: task ? 'this task' : 'your new task',
    form,
    content: editor,
    stored: initial.content,
    open: true,
    initial: useCallback(() => initial, [initial]),
    saveImmediately: true,
  })
  const isAdmin = useIsAdmin()
  const folder = useQuery(
    api.sessionFolders.get,
    folderId ? { folderId } : 'skip',
  )
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
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
  const modelSelection = useTaskModelSelection(model, override)

  const currentKey = workspaceKey(folder?.workspace)
  const workspaceReady = !folderId || !!folder?.workspace
  const hasGrants = grants.shell.length > 0 || grants.paths.length > 0
  const needsApprovalReview = hasGrants && reviewedKey !== currentKey
  const approvalsReady = !needsApprovalReview && (!hasGrants || isAdmin)
  const promptLength = content.trim().length
  const promptTooLong = promptLength > MAX_TASK_PROMPT_CHARS
  const canSave =
    !busy &&
    promptLength > 0 &&
    !promptTooLong &&
    selectedAgent !== undefined &&
    modelSelection.isComplete &&
    workspaceReady &&
    approvalsReady

  function resetGrants(patch?: Partial<TaskFormValues['target']>) {
    setValue(
      'target',
      { ...target, ...patch, grants: emptyApprovals, reviewedKey: null },
      dirty,
    )
  }

  function updateGrants(next: TaskApprovals) {
    if (!next.shell.length && !next.paths.length) return resetGrants()
    setValue(
      'target',
      {
        ...target,
        grants: next,
        reviewedKey: hasGrants ? reviewedKey : currentKey,
      },
      dirty,
    )
  }

  function confirmGrants() {
    setValue('target', { ...target, reviewedKey: currentKey }, dirty)
  }

  function changeAgent(next: string) {
    if (next !== agentId) resetGrants({ agentId: next })
  }

  function changeWorkspace(next: string | null) {
    if (next !== folderId) resetGrants({ folderId: next as typeof folderId })
  }

  function close() {
    draft.clear()
    navigate(back)
  }

  async function submit(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canSave) return
    const prompt =
      content === storedPromptBaseline.current ? initial.content : content
    setBusy(true)
    setFailure('')
    try {
      const id = await save({
        taskId: task?._id,
        reviewedWorkspaceKey:
          hasGrants && folderId ? (reviewedKey ?? undefined) : undefined,
        definition: {
          folderId: folderId ?? undefined,
          approvals: hasGrants ? grants : undefined,
          modelId: modelSelection.value.modelId,
          reasoningEffort: modelSelection.value.reasoningEffort,
          title: getValues('title'),
          prompt,
          agentId: selectedAgent.id,
          schedule,
        },
      })
      if (!mounted.current) return
      draft.clear()
      navigate('/tasks/' + id, { replace: true })
    } catch (cause) {
      if (!mounted.current) return
      setFailure(extractErrorMessage(cause))
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="mx-auto grid w-full max-w-xl gap-5">
      <h1 className="text-2xl font-semibold">
        {task ? 'Edit task' : 'New task'}
      </h1>
      <div className="grid gap-5" inert={busy}>
        <label className={fieldStyle}>
          <span>
            Title <span className="text-muted-foreground">(optional)</span>
          </span>
          <Input
            {...register('title')}
            maxLength={200}
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
                className="h-11 max-w-xs"
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
          model={modelSelection.model}
          value={modelSelection.value}
          onChange={(next) => setValue('model', taskModelSettings(next), dirty)}
        />
        {!isAdmin && hasGrants && (
          <div className={fieldStyle}>
            <p>Administrator access is required to keep automatic approvals.</p>
            <RippleButton
              type="button"
              variant="surface"
              onClick={() => resetGrants()}
            >
              Remove automatic approvals
            </RippleButton>
          </div>
        )}
        <div className={fieldStyle}>
          <span id={promptLabelId}>Prompt</span>
          <PromptContentEditor
            ref={editor}
            value={content}
            onChange={(next) => setValue('content', next, dirty)}
            doc={draft.doc}
            onBaseline={(markdown) => {
              storedPromptBaseline.current = markdown
              draft.onBaseline(markdown)
            }}
            fullscreenId="task-prompt"
            labelledBy={promptLabelId}
            required
            placeholder="What should the agent do?"
            className="h-48"
          />
          {promptTooLong && (
            <p role="status" className="text-destructive">
              Enter a prompt of up to 16,000 characters.
            </p>
          )}
        </div>
        <div className={fieldStyle}>
          <span>Workspace</span>
          <FolderPicker
            value={folderId ?? undefined}
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
            onChange={updateGrants}
            hasWorkspace={!!folderId}
            needsReview={needsApprovalReview}
            onReview={confirmGrants}
          />
        )}
        <RecurrenceEditor
          rule={schedule}
          onChange={(next) => setValue('schedule', next, dirty)}
        />
      </div>
      {failure && (
        <p role="alert" className="text-destructive">
          {failure}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <ConfirmDialog
          disabled={!isDirty}
          variant="destructive"
          title="Discard changes?"
          description="You have unsaved changes that will be lost."
          confirmText="Discard"
          cancelText="Keep editing"
          onConfirm={close}
        >
          <RippleButton
            variant="surface"
            disabled={busy}
            onClick={(event) => {
              if (isDirty) event.preventDefault()
              else close()
            }}
          >
            Cancel
          </RippleButton>
        </ConfirmDialog>
        <RippleButton type="submit" disabled={!canSave}>
          {busy ? 'Saving…' : 'Save task'}
        </RippleButton>
      </div>
    </form>
  )
}
