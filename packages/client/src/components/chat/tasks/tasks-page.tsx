import { RippleButton } from '@/components/ui/ripple-button'
import { Surface } from '@/components/ui/surface'
import { toastError } from '@/lib/notifications'
import { api } from '@cv/convex/_generated/api'
import type { Doc } from '@cv/convex/_generated/dataModel'
import { scheduleLabel } from '@cv/core/task-schedule'
import { useMutation, usePaginatedQuery, useQuery } from 'convex/react'
import { ChevronLeftIcon, PlayIcon } from 'lucide-react'
import { useState } from 'react'
import { Link, Redirect, Route, Switch, useLocation } from 'wouter'

import { TaskEditor } from './task-editor'
import { TaskGrid, taskTitle } from './task-grid'
import { localDate } from './task-recurrence'

function History({ task }: { task: Doc<'scheduledTasks'> }) {
  const setState = useMutation(api.scheduledTasks.setState)
  const runNow = useMutation(api.scheduledTasks.runNow)
  const [starting, setStarting] = useState(false)
  const [, navigate] = useLocation()
  const page = usePaginatedQuery(
    api.scheduledTasks.history,
    { taskId: task._id },
    { initialNumItems: 20 },
  )
  const change = (state: 'paused' | 'active' | 'archived') =>
    setState({ taskId: task._id, state }).catch(toastError)
  const start = () => {
    setStarting(true)
    void runNow({ taskId: task._id })
      .catch(toastError)
      .finally(() => setStarting(false))
  }
  return (
    <div className="mx-auto grid max-w-3xl gap-4">
      <RippleButton
        variant="surface"
        className="justify-self-start"
        render={<Link href="/tasks" />}
      >
        <ChevronLeftIcon aria-hidden="true" />
        All tasks
      </RippleButton>
      <Surface className="grid gap-4 p-5 sm:p-6">
        <h1 className="text-2xl font-semibold wrap-anywhere">
          {taskTitle(task)}
        </h1>
        <div className="text-muted-foreground text-sm">
          {task.agentName} · {scheduleLabel(task.schedule)} ·{' '}
          {task.schedule.zone}
        </div>
        <p className="wrap-anywhere whitespace-pre-wrap">{task.prompt}</p>
        <p className="text-sm">
          {task.nextRunAt
            ? 'Next run · ' + localDate(task.nextRunAt, task.schedule.zone)
            : 'Schedule · ' + task.state}
        </p>
        {task.state !== 'archived' && (
          <div className="flex flex-wrap gap-2">
            <RippleButton
              disabled={starting || !!task.activeRunId}
              onClick={start}
            >
              <PlayIcon aria-hidden="true" />
              {starting ? 'Starting…' : 'Run now'}
            </RippleButton>
            <RippleButton
              variant="surface"
              onClick={() => navigate('/tasks/' + task._id + '/edit')}
            >
              Edit task
            </RippleButton>
            {task.state === 'active' && task.nextRunAt !== undefined && (
              <RippleButton variant="surface" onClick={() => change('paused')}>
                Pause
              </RippleButton>
            )}
            {task.state === 'paused' && (
              <RippleButton variant="surface" onClick={() => change('active')}>
                Resume
              </RippleButton>
            )}
            <RippleButton variant="stealth" onClick={() => change('archived')}>
              Archive
            </RippleButton>
          </div>
        )}
        <h2 className="mt-3 text-xl font-semibold">Run history</h2>
        {!page.results.length && (
          <p>
            {page.status === 'LoadingFirstPage'
              ? 'Loading runs…'
              : 'No runs yet.'}
          </p>
        )}
        {page.results.map((run) => (
          <article key={run._id} className="grid gap-1 border-t py-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <strong className="capitalize">{run.status}</strong>
              {run.sessionId ? (
                <Link
                  href={'/?id=' + run.sessionId}
                  className="text-primary underline"
                >
                  Open session
                </Link>
              ) : (
                <span>Session deleted</span>
              )}
            </div>
            <p className="text-sm">
              {run.agentName} ·{' '}
              {run.trigger === 'manual'
                ? 'Manual run'
                : 'Scheduled ' + localDate(run.scheduledFor, run.zone)}
            </p>
            <p className="text-muted-foreground text-xs">
              Started {localDate(run.startedAt, run.zone)}
              {run.finishedAt &&
                ' · Finished ' + localDate(run.finishedAt, run.zone)}
            </p>
            {run.skippedFrom && (
              <p className="text-muted-foreground text-xs">
                Caught up with the latest occurrence. Earlier times skipped from{' '}
                {localDate(run.skippedFrom, run.zone)}.
              </p>
            )}
            {run.prompt !== task.prompt && (
              <details className="text-sm">
                <summary>Prompt used for this run</summary>
                <p className="wrap-anywhere whitespace-pre-wrap">
                  {run.prompt}
                </p>
              </details>
            )}
            {run.detail && (
              <p className="mt-1 text-sm wrap-anywhere">{run.detail}</p>
            )}
          </article>
        ))}
        {page.status === 'CanLoadMore' && (
          <RippleButton variant="surface" onClick={() => page.loadMore(20)}>
            Older runs
          </RippleButton>
        )}
      </Surface>
    </div>
  )
}

function RunLink({ runId }: { runId: string }) {
  const target = useQuery(api.scheduledTasks.runDestination, { runId })
  if (target === undefined) return <p>Opening run…</p>
  if (!target)
    return (
      <p>
        Run not found. <Link href="/tasks">All tasks</Link>
      </p>
    )
  const path = target.sessionId
    ? '/?id=' + target.sessionId
    : '/tasks/' + target.taskId
  return <Redirect to={path} replace />
}

function TaskDetail({ id, edit }: { id: string; edit?: boolean }) {
  const task = useQuery(api.scheduledTasks.get, {
    taskId: id,
  })
  if (!task)
    return (
      <p>
        {task === null ? 'Task not found.' : 'Loading task…'}{' '}
        <Link href="/tasks">All tasks</Link>
      </p>
    )
  return edit && task.state !== 'archived' ? (
    <TaskEditor key={id} task={task} />
  ) : (
    <History task={task} />
  )
}

export default function TasksPage() {
  return (
    <section className="h-dvh overflow-y-auto px-5 pt-16 pb-12 sm:px-10">
      <Switch>
        <Route path="/tasks/runs/:runId">
          {(params) => <RunLink runId={params.runId} />}
        </Route>
        <Route path="/tasks/new">
          <TaskEditor />
        </Route>
        <Route path="/tasks/:id/edit">
          {(params) => <TaskDetail id={params.id} edit />}
        </Route>
        <Route path="/tasks/:id">
          {(params) => <TaskDetail id={params.id} />}
        </Route>
        <Route>
          <TaskGrid />
        </Route>
      </Switch>
    </section>
  )
}
