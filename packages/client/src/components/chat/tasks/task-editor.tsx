import { Input } from '@/components/ui/input'
import { RippleButton } from '@/components/ui/ripple-button'
import { Textarea } from '@/components/ui/textarea'
import { extractErrorMessage } from '@/lib/errors'
import { api } from '@cv/convex/_generated/api'
import type { Doc, Id } from '@cv/convex/_generated/dataModel'
import { useMutation, useQuery } from 'convex/react'
import { useState } from 'react'
import { useLocation } from 'wouter'

import {
  RecurrenceEditor,
  defaultSchedule,
  fieldStyle,
  selectStyle,
} from './task-recurrence'

export function TaskEditor({ task }: { task?: Doc<'scheduledTasks'> }) {
  const [, navigate] = useLocation()
  const agents = useQuery(api.agents.list, {})
  const save = useMutation(api.scheduledTasks.save)
  const [rule, setRule] = useState(() => task?.schedule ?? defaultSchedule())
  const [selectedAgent, setSelectedAgent] = useState<string>(
    task?.agentId ?? '',
  )
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  const back = task ? '/tasks/' + task._id : '/tasks'
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    const fields = new FormData(event.currentTarget)
    setBusy(true)
    setFailure('')
    try {
      const id = await save({
        taskId: task?._id,
        definition: {
          title: String(fields.get('title')),
          prompt: String(fields.get('prompt')),
          agentId: String(fields.get('agent')) as Id<'agents'>,
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
        Title (optional)
        <Input
          name="title"
          maxLength={200}
          defaultValue={task?.title}
          placeholder="Morning mailbox"
        />
      </label>
      <label className={fieldStyle}>
        Agent
        <select
          aria-label="Agent"
          name="agent"
          required
          value={selectedAgent}
          onChange={(event) => setSelectedAgent(event.target.value)}
          className={selectStyle}
        >
          <option value="">Select an agent</option>
          {agents?.map((agent) => (
            <option key={agent._id} value={agent._id}>
              {agent.name}
            </option>
          ))}
        </select>
      </label>
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
        <RippleButton type="submit" disabled={busy || !agents?.length}>
          {busy ? 'Saving…' : 'Save task'}
        </RippleButton>
      </div>
    </form>
  )
}
