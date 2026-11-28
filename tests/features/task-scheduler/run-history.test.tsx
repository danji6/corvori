import { TaskRunHistory } from '@/components/chat/tasks/task-run-history'
import type { Id } from '@cv/convex/_generated/dataModel'
import { expect, spyOn, test } from 'bun:test'
import { ConvexProvider, ConvexReactClient } from 'convex/react'
import type { PaginationOptions } from 'convex/server'
import { act, useRef } from 'react'
import { setupReactDom } from '~/tests/setup/dom'

setupReactDom()

const task = { _id: 'task' as Id<'scheduledTasks'>, prompt: 'Check mail' }
const runs = Array.from({ length: 23 }, (_, index) => ({
  _id: `run-${index}`,
  status: 'succeeded',
  trigger: 'manual',
  agentName: `Run ${index + 1}`,
  startedAt: 1_000,
  prompt: task.prompt,
  zone: 'UTC',
}))

function HistoryInScroller() {
  const root = useRef<HTMLElement>(null)
  return (
    <section ref={root}>
      <TaskRunHistory task={task} scrollRoot={root} />
    </section>
  )
}

function watchHistory(client: ConvexReactClient) {
  const requests = new Map<string | null, number>()
  const watch = spyOn(client, 'watchQuery').mockImplementation((_ref, args) => {
    const { cursor, numItems } = (args as { paginationOpts: PaginationOptions })
      .paginationOpts
    const start = Number(cursor)
    const end = start + numItems
    requests.set(cursor, numItems)
    return {
      onUpdate: () => () => {},
      localQueryResult: () => ({
        page: runs.slice(start, end),
        isDone: end >= runs.length,
        continueCursor: String(end),
      }),
    } as never
  })
  return { requests, restore: () => watch.mockRestore() }
}

test('scrolling run history requests ten runs at a time until the cursor is exhausted', async () => {
  const { createRoot } = await import('react-dom/client')
  const container = document.createElement('div')
  const root = createRoot(container)
  const client = new ConvexReactClient('http://localhost:3210')
  const { requests, restore } = watchHistory(client)
  const NativeObserver = globalThis.IntersectionObserver
  let intersect: ((visible: boolean) => void) | undefined
  let observerRoot: IntersectionObserverInit['root']
  globalThis.IntersectionObserver = class extends NativeObserver {
    constructor(
      callback: IntersectionObserverCallback,
      options?: IntersectionObserverInit,
    ) {
      super(callback, options)
      observerRoot = options?.root
      intersect = (isIntersecting) =>
        callback([{ isIntersecting } as IntersectionObserverEntry], this)
    }
    override observe() {}
    override disconnect() {
      intersect = undefined
    }
  }

  try {
    await act(async () => {
      root.render(
        <ConvexProvider client={client}>
          <HistoryInScroller />
        </ConvexProvider>,
      )
    })
    expect(observerRoot).toBe(container.querySelector('section')!)
    expect(container.querySelectorAll('article')).toHaveLength(10)
    expect([...requests]).toEqual([[null, 10]])

    await act(async () => intersect?.(false))
    expect(requests.size).toBe(1)

    await act(async () => intersect?.(true))
    expect(container.querySelectorAll('article')).toHaveLength(20)
    expect([...requests]).toEqual([
      [null, 10],
      ['10', 10],
    ])

    await act(async () => intersect?.(true))
    expect(container.querySelectorAll('article')).toHaveLength(23)
    expect([...requests]).toEqual([
      [null, 10],
      ['10', 10],
      ['20', 10],
    ])
    expect(intersect).toBeUndefined()
  } finally {
    act(() => root.unmount())
    globalThis.IntersectionObserver = NativeObserver
    restore()
    await client.close()
  }
})
