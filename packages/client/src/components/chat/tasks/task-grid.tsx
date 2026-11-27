import { Input, RippleButton } from '@/components/ui'
import { api } from '@cv/convex/_generated/api'
import type { Doc } from '@cv/convex/_generated/dataModel'
import { scheduleLabel } from '@cv/core/task-schedule'
import { usePaginatedQuery } from 'convex/react'
import { BotIcon, CalendarClockIcon, PlusIcon } from 'lucide-react'
import { useState } from 'react'
import { Link, useLocation } from 'wouter'

import { localDate } from './task-recurrence'

export function taskTitle(task: Doc<'scheduledTasks'>) {
  return task.title || task.prompt.split('\n', 1)[0]
}

function TaskCard({ task }: { task: Doc<'scheduledTasks'> }) {
  return (
    <Link
      href={'/tasks/' + task._id}
      className="bg-m3-surface-container-low hover:bg-m3-surface-container focus-visible:ring-ring flex min-w-0 flex-col gap-3 rounded-2xl border p-5 focus-visible:ring-2"
    >
      <span className="text-muted-foreground flex items-center gap-2 text-sm">
        <BotIcon className="size-4" />
        <span className="truncate">{task.agentName}</span>
      </span>
      <h2 className="line-clamp-2 text-lg font-semibold wrap-anywhere">
        {taskTitle(task)}
      </h2>
      <span className="flex items-start gap-2 text-sm">
        <CalendarClockIcon className="mt-0.5 size-4 shrink-0" />
        {scheduleLabel(task.schedule)}
      </span>
      <p className="text-muted-foreground line-clamp-3 text-sm wrap-anywhere">
        {task.prompt}
      </p>
      <div className="mt-auto grid gap-1 border-t pt-3 text-xs">
        {task.nextRunAt ? (
          <span>Next · {localDate(task.nextRunAt, task.schedule.zone)}</span>
        ) : (
          <span className="capitalize">{task.state}</span>
        )}
        {task.latestStatus && <span>Latest run · {task.latestStatus}</span>}
      </div>
    </Link>
  )
}

export function TaskGrid() {
  const [, navigate] = useLocation()
  const [search, setSearch] = useState('')
  const [archived, setArchived] = useState(false)
  const page = usePaginatedQuery(
    api.scheduledTasks.list,
    { search, archived },
    { initialNumItems: 24 },
  )
  return (
    <div className="mx-auto grid max-w-5xl gap-5">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-3xl font-semibold">Tasks</h1>
        <RippleButton onClick={() => navigate('/tasks/new')}>
          <PlusIcon />
          New task
        </RippleButton>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Input
          type="search"
          className="max-w-md"
          aria-label="Search tasks"
          placeholder="Search by title, agent, or prompt"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={archived}
            onChange={(e) => setArchived(e.target.checked)}
          />
          Archived tasks
        </label>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {page.results.map((task) => (
          <TaskCard task={task} key={task._id} />
        ))}
      </div>
      {!page.results.length && (
        <p className="text-muted-foreground">
          {page.status === 'LoadingFirstPage'
            ? 'Loading tasks…'
            : search
              ? 'No matching tasks.'
              : archived
                ? 'No archived tasks.'
                : 'No tasks yet. Create one to schedule an agent.'}
        </p>
      )}
      {page.status === 'CanLoadMore' && (
        <RippleButton
          className="justify-self-start"
          variant="surface"
          onClick={() => page.loadMore(24)}
        >
          Load more tasks
        </RippleButton>
      )}
    </div>
  )
}
