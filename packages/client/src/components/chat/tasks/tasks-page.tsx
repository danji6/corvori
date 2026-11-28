import { RippleButton } from '@/components/ui/ripple-button'
import { Surface } from '@/components/ui/surface'
import { toastError } from '@/lib/notifications'
import { api } from '@cv/convex/_generated/api'
import type { Doc } from '@cv/convex/_generated/dataModel'
import { scheduleLabel } from '@cv/core/task-schedule'
import { useMutation, useQuery } from 'convex/react'
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ChevronLeftIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
} from 'lucide-react'
import { type RefObject, useRef, useState } from 'react'
import { Link, Redirect, Route, Switch, useLocation } from 'wouter'

import { TaskEditor } from './task-editor'
import { TaskGrid, taskTitle } from './task-grid'
import { localDate } from './task-recurrence'
import { TaskRunHistory } from './task-run-history'

type TaskDetailsProps = {
  task: Doc<'scheduledTasks'>
  scrollRoot: RefObject<HTMLElement | null>
}

function TaskDetails({ task, scrollRoot }: TaskDetailsProps) {
  const setState = useMutation(api.scheduledTasks.setState)
  const unarchive = useMutation(api.scheduledTasks.unarchive)
  const runNow = useMutation(api.scheduledTasks.runNow)
  const [starting, setStarting] = useState(false)
  const [, navigate] = useLocation()

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
        {task.state === 'archived' ? (
          <RippleButton
            variant="input"
            className="justify-self-start"
            onClick={() => unarchive({ taskId: task._id }).catch(toastError)}
          >
            <ArchiveRestoreIcon aria-hidden="true" /> Unarchive
          </RippleButton>
        ) : (
          <div className="flex flex-wrap gap-2">
            <RippleButton
              disabled={starting || !!task.activeRunId}
              onClick={start}
            >
              <PlayIcon aria-hidden="true" />
              {starting ? 'Starting…' : 'Run now'}
            </RippleButton>
            <RippleButton
              variant="input"
              onClick={() => navigate('/tasks/' + task._id + '/edit')}
            >
              <PencilIcon aria-hidden="true" /> Edit task
            </RippleButton>
            {task.state === 'active' && task.nextRunAt !== undefined && (
              <RippleButton variant="input" onClick={() => change('paused')}>
                <PauseIcon aria-hidden="true" /> Pause
              </RippleButton>
            )}
            {task.state === 'paused' && (
              <RippleButton variant="input" onClick={() => change('active')}>
                <PlayIcon aria-hidden="true" /> Resume
              </RippleButton>
            )}
            <RippleButton variant="input" onClick={() => change('archived')}>
              <ArchiveIcon aria-hidden="true" /> Archive
            </RippleButton>
          </div>
        )}
        <TaskRunHistory task={task} scrollRoot={scrollRoot} />
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

type TaskDetailRouteProps = Pick<TaskDetailsProps, 'scrollRoot'> & {
  id: string
  edit?: boolean
}

function TaskDetailRoute({ id, edit, scrollRoot }: TaskDetailRouteProps) {
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
  if (edit) {
    if (task.state === 'archived')
      return <Redirect to={'/tasks/' + id} replace />
    return <TaskEditor key={id} task={task} />
  }
  return <TaskDetails key={id} task={task} scrollRoot={scrollRoot} />
}

export default function TasksPage() {
  const scrollRoot = useRef<HTMLElement>(null)
  return (
    <section
      ref={scrollRoot}
      className="h-dvh overflow-y-auto px-5 pt-16 pb-12 sm:px-10"
    >
      <Switch>
        <Route path="/tasks/runs/:runId">
          {(params) => <RunLink runId={params.runId} />}
        </Route>
        <Route path="/tasks/new">
          <TaskEditor />
        </Route>
        <Route path="/tasks/:id/edit">
          {(params) => (
            <TaskDetailRoute id={params.id} edit scrollRoot={scrollRoot} />
          )}
        </Route>
        <Route path="/tasks/:id">
          {(params) => (
            <TaskDetailRoute id={params.id} scrollRoot={scrollRoot} />
          )}
        </Route>
        <Route>
          <TaskGrid />
        </Route>
      </Switch>
    </section>
  )
}
