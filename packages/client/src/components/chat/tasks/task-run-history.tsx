import { RippleButton } from '@/components/ui/ripple-button'
import { api } from '@cv/convex/_generated/api'
import type { Doc } from '@cv/convex/_generated/dataModel'
import { usePaginatedQuery } from 'convex/react'
import { type RefObject, useEffect, useRef } from 'react'
import { Link } from 'wouter'

import { localDate } from './task-recurrence'

const RUN_PAGE_SIZE = 10

type TaskRunHistoryProps = {
  task: Pick<Doc<'scheduledTasks'>, '_id' | 'prompt'>
  scrollRoot: RefObject<HTMLElement | null>
}

export function TaskRunHistory({ task, scrollRoot }: TaskRunHistoryProps) {
  const sentinel = useRef<HTMLDivElement>(null)
  const { results, status, loadMore } = usePaginatedQuery(
    api.scheduledTasks.history,
    { taskId: task._id },
    { initialNumItems: RUN_PAGE_SIZE },
  )

  useEffect(() => {
    const element = sentinel.current
    if (!element || status !== 'CanLoadMore') return
    if (typeof IntersectionObserver === 'undefined') return

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          loadMore(RUN_PAGE_SIZE)
        }
      },
      { root: scrollRoot.current, rootMargin: '0px 0px 200px 0px' },
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [loadMore, scrollRoot, status])

  return (
    <>
      <h2 className="mt-3 text-xl font-semibold">Run history</h2>
      {status === 'LoadingFirstPage' && <p role="status">Loading runs…</p>}
      {status === 'Exhausted' && !results.length && <p>No runs yet.</p>}
      {results.map((run) => (
        <TaskRun key={run._id} run={run} taskPrompt={task.prompt} />
      ))}
      {status === 'CanLoadMore' && (
        <div ref={sentinel}>
          <RippleButton
            variant="surface"
            onClick={() => loadMore(RUN_PAGE_SIZE)}
          >
            Load older runs
          </RippleButton>
        </div>
      )}
      {status === 'LoadingMore' && <p role="status">Loading older runs…</p>}
    </>
  )
}

function TaskRun({
  run,
  taskPrompt,
}: {
  run: Doc<'scheduledTaskRuns'>
  taskPrompt: string
}) {
  return (
    <article className="grid gap-1 border-t py-4">
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
        {run.finishedAt && ' · Finished ' + localDate(run.finishedAt, run.zone)}
      </p>
      {run.skippedFrom && (
        <p className="text-muted-foreground text-xs">
          Caught up with the latest occurrence. Earlier times skipped from{' '}
          {localDate(run.skippedFrom, run.zone)}.
        </p>
      )}
      {run.prompt !== taskPrompt && (
        <details className="text-sm">
          <summary>Prompt used for this run</summary>
          <p className="wrap-anywhere whitespace-pre-wrap">{run.prompt}</p>
        </details>
      )}
      {run.detail && <p className="mt-1 text-sm wrap-anywhere">{run.detail}</p>}
    </article>
  )
}
